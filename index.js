require("dotenv").config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, InteractionType } = require("discord.js");
const { OpenAI } = require("openai");
const { Octokit } = require("@octokit/rest");
const express = require("express");

// Configuration

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const openai  = new OpenAI({ apiKey: process.env.OPENAI_KEY });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });


const IGNORE_PREFIX      = "!";                              
const CHANNELS_WHITELIST = ["1367412607518113853"];          
const HISTORY_LIMIT      = 10;                               
const CHUNK_SIZE         = 1900;                             

const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO  = process.env.GITHUB_REPO;

let repoContext = null;                                       


const pendingInteractions = new Map();


function formatDateFR(date) {
  const d = new Date(date);
  return d.toLocaleDateString("fr-CA", { year: "numeric", month: "2-digit", day: "2-digit" }) +
         " " +
         d.toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function chunkString(str) {
  if (str.length <= CHUNK_SIZE) return [str];
  const chunks = [];
  for (let i = 0; i < str.length; i += CHUNK_SIZE) {
    chunks.push(str.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

function mapDiscordHistory(msgs) {
  
  return msgs
    .reverse() 
    .map(m => ({ role: m.author.bot ? "assistant" : "user", content: m.content }))
    .filter(m => m.content?.length);
}

function extractBranchFromMessage(message) {
  
  const branchMatch = message.match(/branch\s+(\w+)/i) || message.match(/branche\s+(\w+)/i);
  return branchMatch ? branchMatch[1] : null;
}


process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Github

async function fetchRepoInfo() {
  try {
    const { data } = await octokit.repos.get({ owner: GITHUB_OWNER, repo: GITHUB_REPO });
    return {
      name:            data.name,
      description:     data.description,
      default_branch:  data.default_branch,
      lastUpdated:     new Date().toISOString()
    };
  } catch (error) {
    console.error("Erreur lors de la récupération des infos du repo:", error);
    throw error;
  }
}

async function getLastCommit(branch = null) {
  try {
    const { data: commits } = await octokit.repos.listCommits({
      owner: GITHUB_OWNER,
      repo:  GITHUB_REPO,
      sha:   branch || (repoContext ? repoContext.default_branch : 'main'),
      per_page: 1
    });
    if (!commits.length) return null;
    const sha = commits[0].sha;
    return await getCommitDetails(sha);
  } catch (error) {
    console.error("Erreur lors de la récupération du dernier commit:", error);
    throw error;
  }
}

async function findCommitByMessage(message, branch = null) {
  try {
    const { data: commits } = await octokit.repos.listCommits({
      owner: GITHUB_OWNER,
      repo:  GITHUB_REPO,
      sha:   branch || (repoContext ? repoContext.default_branch : 'main'),
      per_page: 50
    });
    const found = commits.find(c => c.commit.message.toLowerCase().includes(message.toLowerCase()));
    return found ? getCommitDetails(found.sha) : null;
  } catch (error) {
    console.error("Erreur lors de la recherche du commit:", error);
    throw error;
  }
}

async function getCommitDetails(sha) {
  try {
    const { data } = await octokit.repos.getCommit({ owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: sha });
    return {
      sha:      data.sha,
      message:  data.commit.message,
      author:   data.commit.author.name,
      date:     formatDateFR(data.commit.author.date),
      files:    data.files.map(f => ({
        filename:   f.filename,
        status:     f.status,
        additions:  f.additions,
        deletions:  f.deletions,
        changes:    f.changes,
        patch:      f.patch         
      }))
    };
  } catch (error) {
    console.error(`Erreur lors de la récupération des détails du commit ${sha}:`, error);
    throw error;
  }
}

async function getFileContent(path, branch = null) {
  try {
    const { data } = await octokit.repos.getContent({ 
      owner: GITHUB_OWNER, 
      repo: GITHUB_REPO, 
      path, 
      ref: branch || (repoContext ? repoContext.default_branch : 'main') 
    });
    return Buffer.from(data.content, "base64").toString();
  } catch (error) {
    console.error(`Erreur lors de la récupération du fichier ${path}:`, error);
    throw error;
  }
}

// Openai wrappers

async function generateCommitSummary(commit) {
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "Tu es un assistant spécialisé dans l'analyse de code. Analyse les modifications suivantes et résume-les de manière concise et claire. Explique les changements principaux et leur impact potentiel. Ne mentionne pas l'auteur, le nom du commit ou la date car ces informations seront ajoutées séparément. Réponds en français." },
        { role: "user",   content: JSON.stringify(commit, null, 2) }
      ]
    });
    return resp.choices[0].message.content.trim();
  } catch (error) {
    console.error("Erreur lors de la génération du résumé du commit:", error);
    throw error;
  }
}

async function answerWithContext(channel, userMsg) {
  try {
    
    const history = await channel.messages.fetch({ limit: HISTORY_LIMIT });
    const chatHistory = mapDiscordHistory(history);

    
    const gitContext = [];
    const userMessage = userMsg.content.toLowerCase();
    
    
    const shaMatch = userMsg.content.match(/[a-f0-9]{7,40}/);
    if (shaMatch) {
      try {
        const commit = await getCommitDetails(shaMatch[0]);
        gitContext.push({ role: "system", content: `Détails du commit ${shaMatch[0]} :\n${JSON.stringify(commit, null, 2)}` });
      } catch {/* ignore */}
    }
    
    
    if (userMessage.includes('github') || 
        userMessage.includes('commit') || 
        userMessage.includes('dépôt') || 
        userMessage.includes('repo') || 
        userMessage.includes('branche') || 
        userMessage.includes('branch')) {
      
      
      if (userMessage.includes('resume') && userMessage.includes('dernier commit')) {
        let branch = extractBranchFromMessage(userMessage);
        
        try {
          const commit = await getLastCommit(branch);
          
          if (commit) {
            gitContext.push({
              role: 'system',
              content: `Informations sur le dernier commit${branch ? ` de la branche ${branch}` : ''} :
              SHA: ${commit.sha}
              Message: ${commit.message}
              Auteur: ${commit.author}
              Date: ${commit.date}
              Fichiers modifiés: ${commit.files.length}
              
              Détails des modifications:
              ${JSON.stringify(commit.files, null, 2)}`
            });
          }
        } catch (error) {
          console.error("Erreur lors de la récupération du commit:", error);
        }
      }
      
      else if (userMessage.includes('resume') && userMessage.includes('commit')) {
        
        const commitMatch = userMessage.match(/commit\s+[\"\'](.*?)[\"\']/) || // "commit 'message'"
                            userMessage.match(/commit\s+([^\s]+)/) ||         // "commit message"
                            userMessage.match(/le\s+commit\s+[\"\'](.*?)[\"\']/) || // "le commit 'message'"
                            userMessage.match(/le\s+commit\s+([^\s]+)/);       // "le commit message"
        
        if (commitMatch && commitMatch[1]) {
          const commitMessage = commitMatch[1];
          let branch = extractBranchFromMessage(userMessage);
          
          try {
            const commit = await findCommitByMessage(commitMessage, branch);
            
            if (commit) {
              gitContext.push({
                role: 'system',
                content: `Informations sur le commit "${commit.message}"${branch ? ` de la branche ${branch}` : ''} :
                SHA: ${commit.sha}
                Message: ${commit.message}
                Auteur: ${commit.author}
                Date: ${commit.date}
                Fichiers modifiés: ${commit.files.length}
                
                Détails des modifications:
                ${JSON.stringify(commit.files, null, 2)}`
              });
            }
          } catch (error) {
            console.error("Erreur lors de la recherche du commit:", error);
          }
        }
      }
    }

    // OpenAI
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: `Tu es un assistant IA intégré à Discord nommé ${client.user.username}.
        
        RÈGLES DE BASE:
        - Réponds toujours en français par défaut, sauf si la question est posée en anglais
        - Sois clair, précis et utile dans tes réponses
        - Tu es spécialisé dans l'aide au développement et peux aider avec du code
        
        CONTEXTE GITHUB:
        - Tu as accès au dépôt GitHub: ${GITHUB_OWNER}/${GITHUB_REPO}
        - Branche par défaut: ${repoContext?.default_branch || "Non disponible"}
        - Description: ${repoContext?.description || "Non disponible"}
        
        FONCTIONNALITÉS:
        - Tu peux résumer le dernier commit d'une branche avec la commande /resume_last_commit [branch]
        - Tu peux résumer un commit spécifique avec la commande /resume_commit [commit] [branch]
        - Tu peux afficher les informations du dépôt avec /info_repo
        - Tu peux afficher le contenu d'un fichier avec /contenu_fichier [chemin] [branch]
        
        Si l'utilisateur demande des informations sur le dépôt GitHub, rappelle-lui qu'il peut utiliser ces commandes ou pose-lui des questions sur GitHub directement.` },
        ...gitContext,
        ...chatHistory,
        { role: "user", content: userMsg.content }
      ]
    });

    return resp.choices[0].message.content;
  } catch (error) {
    console.error("Erreur lors de la génération de la réponse:", error);
    throw error;
  }
}

// Slash Commands

async function registerCommands() {
  try {
    const commands = [
      new SlashCommandBuilder().setName("resume_last_commit").setDescription("Résume le dernier commit d'une branche").addStringOption(o => o.setName("branch").setDescription("Nom de la branche (laissez vide pour la branche par défaut)").setRequired(false)),
      new SlashCommandBuilder().setName("resume_commit").setDescription("Résume un commit spécifique d'une branche").addStringOption(o => o.setName("commit").setDescription("Titre ou partie du message du commit à rechercher").setRequired(true)).addStringOption(o => o.setName("branch").setDescription("Nom de la branche (laissez vide pour la branche par défaut)").setRequired(false)),
      new SlashCommandBuilder().setName("info_repo").setDescription("Affiche les informations sur le dépôt GitHub"),
      new SlashCommandBuilder().setName("contenu_fichier").setDescription("Affiche le contenu d'un fichier du dépôt").addStringOption(o => o.setName("chemin").setDescription("Chemin du fichier").setRequired(true)).addStringOption(o => o.setName("branch").setDescription("Nom de la branche (laissez vide pour la branche par défaut)").setRequired(false))
    ];
    const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Slash-cmds enregistrées");
  } catch (error) {
    console.error("Erreur lors de l'enregistrement des commandes slash:", error);
  }
}

// Bots

client.on("ready", async () => {
  console.log(`${client.user.tag} est en ligne !`);
  try {
    repoContext = await fetchRepoInfo();
    console.log("Contexte GitHub chargé");
  } catch (err) { 
    console.error("GitHub init error:", err); 
  }
  await registerCommands();
});


async function handleSlashCommand(interaction) {
  if (!interaction.isCommand()) return;
  

  const { commandName, options } = interaction;
  const branch = options.getString("branch");
  const commitKey = commandName === "resume_commit" ? options.getString("commit") : null;
  const path = commandName === "contenu_fichier" ? options.getString("chemin") : null;
  
  let responseMessage = "";
  
  try {
    
    await interaction.reply({ content: "Traitement en cours...", ephemeral: false });
    
    
    if (commandName === "resume_last_commit") {
      const commit = await getLastCommit(branch);
      
      if (!commit) {
        responseMessage = 'Aucun commit trouvé sur cette branche.';
      } else {
        const summary = await generateCommitSummary(commit);
        
        responseMessage = 
          `**Résumé du dernier commit${branch ? ` sur la branche ${branch}` : ''}:**\n\n` +
          `**Auteur:** ${commit.author}\n` +
          `**Nom du commit:** ${commit.message}\n` +
          `**Date:** ${commit.date}\n\n` +
          `${summary}`;
      }
    }
    
    else if (commandName === "resume_commit") {
      
      const commit = commitKey.match(/^[a-f0-9]{7,40}$/i) 
        ? await getCommitDetails(commitKey) 
        : await findCommitByMessage(commitKey, branch);
      
      if (!commit) {
        responseMessage = `Aucun commit contenant "${commitKey}" n'a été trouvé${branch ? ` sur la branche ${branch}` : ''}.`;
      } else {
        const summary = await generateCommitSummary(commit);
        
        responseMessage = 
          `**Résumé du commit "${commit.message.split('\n')[0]}"${branch ? ` sur la branche ${branch}` : ''}:**\n\n` +
          `**Auteur:** ${commit.author}\n` +
          `**SHA:** ${commit.sha.substring(0, 7)}\n` +
          `**Date:** ${commit.date}\n\n` +
          `${summary}`;
      }
    }
    
    else if (commandName === "info_repo") {
      
      repoContext = await fetchRepoInfo();
      
      responseMessage = `**Informations sur le dépôt ${repoContext.name}:**\n\n` +
        `📝 Description: ${repoContext.description || 'Aucune description'}\n` +
        `🌿 Branche par défaut: ${repoContext.default_branch}\n` +
        `🔄 Dernière mise à jour des informations: ${new Date(repoContext.lastUpdated).toLocaleString('fr-FR')}`;
    }
    
    else if (commandName === "contenu_fichier") {
      const content = await getFileContent(path, branch);
      
      
      if (content.length > CHUNK_SIZE) {
        responseMessage = `Le fichier **${path}** est trop volumineux pour être affiché en entier. Voici les premières lignes:\n\n\`\`\`\n${content.substring(0, CHUNK_SIZE - 100)}\n...\n\`\`\``;
      } else {
        responseMessage = `Contenu du fichier **${path}**${branch ? ` (branche: ${branch})` : ''}:\n\n\`\`\`\n${content}\n\`\`\``;
      }
    }
    
    
    await interaction.editReply(responseMessage);
    
  } catch (error) {
    console.error(`Erreur lors de l'exécution de la commande ${commandName}:`, error);
    try {
      
      const errorMessage = `Désolé, une erreur s'est produite: ${error.message}`;
      
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(errorMessage);
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    } catch (followupError) {
      console.error("Erreur lors de l'envoi du message d'erreur:", followupError);
      
      
      if (interaction.channel) {
        try {
          await interaction.channel.send(`Erreur lors de l'exécution de la commande ${commandName}: ${error.message}`);
        } catch (finalError) {
          console.error("Impossible d'envoyer un message dans le canal:", finalError);
        }
      }
    }
  }
}

// Interactions

client.on("interactionCreate", async interaction => {
  if (interaction.isCommand()) {
    await handleSlashCommand(interaction);
  }
});

// Message
client.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (message.content.startsWith(IGNORE_PREFIX)) return;
  if (!CHANNELS_WHITELIST.includes(message.channelId) && !message.mentions.users.has(client.user.id)) return;

  await message.channel.sendTyping();
  const typing = setInterval(() => message.channel.sendTyping(), 5000);

  try {
    const answer = await answerWithContext(message.channel, message);
    clearInterval(typing);

    
    for (const chunk of chunkString(answer)) {
      await message.reply(chunk);
    }
  } catch (err) {
    clearInterval(typing);
    console.error("msgCreate error:", err);
    await message.reply(`Erreur : ${err.message}`);
  }
});

// Logins
client.login(process.env.TOKEN);

client.on('error', error => {
  console.error('Erreur Discord client:', error);
});

const app = express();
app.get("/", (_, res) => res.send("Bot Discord actif"));
app.listen(process.env.PORT || 10000, () => console.log("Serveur HTTP démarré"));
