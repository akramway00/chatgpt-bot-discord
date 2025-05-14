require("dotenv").config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { OpenAI } = require("openai");
const { Octokit } = require("@octokit/rest");


const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
});


const openai = new OpenAI({
    apiKey: process.env.OPENAI_KEY,
});


const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});


const IGNORE_PREFIX = "!";
const CHANNELS = ['1367412607518113853'];
const GITHUB_OWNER = process.env.GITHUB_OWNER; 
const GITHUB_REPO = process.env.GITHUB_REPO; 


let repoContext = null;

// Initialisation du bot
client.on("ready", async () => {
    console.log(`${client.user.tag} est en ligne !`);
    
    // contexte GitHub
    try {
        repoContext = await fetchRepoInfo();
        console.log("Contexte GitHub chargé avec succès");
    } catch (error) {
        console.error("Erreur lors du chargement du contexte GitHub:", error);
    }
    
    // Enregistrement des commandes slash
    registerCommands();
});

// Fonction pour récupérer les informations de base du repo
async function fetchRepoInfo() {
    try {
        const { data: repo } = await octokit.repos.get({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
        });
        
        return {
            name: repo.name,
            description: repo.description,
            default_branch: repo.default_branch,
            lastUpdated: new Date().toISOString(),
        };
    } catch (error) {
        console.error("Erreur lors de la récupération des infos du repo:", error);
        throw error;
    }
}

// Fonction pour récupérer le dernier commit d'une branche
async function getLastCommit(branch = null) {
    try {
        const { data: commits } = await octokit.repos.listCommits({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            sha: branch || repoContext.default_branch,
            per_page: 1,
        });
        
        if (commits.length === 0) {
            return null;
        }
        
        // Récupérer les détails du commit
        const { data: commitDetails } = await octokit.repos.getCommit({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            ref: commits[0].sha,
        });
        
        return {
            sha: commits[0].sha,
            message: commits[0].commit.message,
            author: commits[0].commit.author.name,
            date: commits[0].commit.author.date,
            files: commitDetails.files.map(file => ({
                filename: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patch: file.patch
            }))
        };
    } catch (error) {
        console.error("Erreur lors de la récupération du dernier commit:", error);
        throw error;
    }
}

// Fonction pour rechercher un commit spécifique par message
async function findCommitByMessage(commitMessage, branch = null) {
    try {
        // Récupérer les 50 derniers commits de la branche
        const { data: commits } = await octokit.repos.listCommits({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            sha: branch || repoContext.default_branch,
            per_page: 50,
        });
        
        if (commits.length === 0) {
            return null;
        }
        
        // Rechercher un commit dont le message contient la chaîne de recherche
        const foundCommit = commits.find(commit => 
            commit.commit.message.toLowerCase().includes(commitMessage.toLowerCase())
        );
        
        if (!foundCommit) {
            return null;
        }
        
        // Récupérer les détails du commit trouvé
        const { data: commitDetails } = await octokit.repos.getCommit({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            ref: foundCommit.sha,
        });
        
        return {
            sha: foundCommit.sha,
            message: foundCommit.commit.message,
            author: foundCommit.commit.author.name,
            date: foundCommit.commit.author.date,
            files: commitDetails.files.map(file => ({
                filename: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patch: file.patch
            }))
        };
    } catch (error) {
        console.error("Erreur lors de la recherche du commit:", error);
        throw error;
    }
}

// Fonction pour récupérer le contenu d'un fichier spécifique
async function getFileContent(path, branch = null) {
    try {
        const { data } = await octokit.repos.getContent({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: path,
            ref: branch || repoContext.default_branch,
        });
        
        const content = Buffer.from(data.content, 'base64').toString();
        return content;
    } catch (error) {
        console.error(`Erreur lors de la récupération du fichier ${path}:`, error);
        throw error;
    }
}

// Fonction pour enregistrer les commandes slash
async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('resume_last_commit')
            .setDescription('Résume le dernier commit d\'une branche')
            .addStringOption(option => 
                option.setName('branch')
                      .setDescription('Nom de la branche (laissez vide pour la branche par défaut)')
                      .setRequired(false)),
                      
        new SlashCommandBuilder()
            .setName('resume_commit')
            .setDescription('Résume un commit spécifique d\'une branche')
            .addStringOption(option =>
                option.setName('commit')
                      .setDescription('Titre ou partie du message du commit à rechercher')
                      .setRequired(true))
            .addStringOption(option => 
                option.setName('branch')
                      .setDescription('Nom de la branche (laissez vide pour la branche par défaut)')
                      .setRequired(false)),
                      
        new SlashCommandBuilder()
            .setName('info_repo')
            .setDescription('Affiche les informations sur le dépôt GitHub'),
            
        new SlashCommandBuilder()
            .setName('contenu_fichier')
            .setDescription('Affiche le contenu d\'un fichier du dépôt')
            .addStringOption(option => 
                option.setName('chemin')
                      .setDescription('Chemin du fichier')
                      .setRequired(true))
            .addStringOption(option => 
                option.setName('branch')
                      .setDescription('Nom de la branche (laissez vide pour la branche par défaut)')
                      .setRequired(false)),
    ];

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
        
        console.log('Rafraîchissement des commandes slash...');
        
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        
        console.log('Commandes slash enregistrées avec succès!');
    } catch (error) {
        console.error('Erreur lors de l\'enregistrement des commandes slash:', error);
    }
}


async function generateCommitSummary(commit, branch = null) {
    try {
        
        const response = await openai.chat.completions.create({
            model: 'gpt-4.1-mini',
            messages: [
                {
                    role: 'system',
                    content: 'Tu es un assistant spécialisé dans l\'analyse de code. Analyse les modifications suivantes et résume-les de manière concise et claire. Explique les changements principaux et leur impact potentiel. Ne mentionne pas l\'auteur, le nom du commit ou la date car ces informations seront ajoutées séparément. Réponds en français.'
                },
                {
                    role: 'user',
                    content: `Résume le commit suivant:\n
                    Message: ${commit.message}\n
                    Auteur: ${commit.author}\n
                    Date: ${commit.date}\n
                    Fichiers modifiés: ${commit.files.length}\n\n
                    Détails des modifications:\n${JSON.stringify(commit.files, null, 2)}`
                }
            ],
        });
        
        
        const commitDate = new Date(commit.date);
        const formattedDate = commitDate.toLocaleDateString('fr-FR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }) + ' ' + commitDate.toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        
        
        return {
            summary: response.choices[0].message.content,
            formattedDate: formattedDate,
            commitInfo: {
                sha: commit.sha,
                message: commit.message,
                author: commit.author,
                date: formattedDate
            }
        };
    } catch (error) {
        console.error("Erreur lors de la génération du résumé du commit:", error);
        throw error;
    }
}

// Gestion des commandes slash
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    
    await interaction.deferReply();
    
    const { commandName, options } = interaction;
    
    try {
        if (commandName === 'resume_last_commit') {
            const branch = options.getString('branch');
            const commit = await getLastCommit(branch);
            
            if (!commit) {
                return interaction.editReply('Aucun commit trouvé sur cette branche.');
            }
            
            const summaryResult = await generateCommitSummary(commit, branch);
            
            await interaction.editReply(
                `**Résumé du dernier commit${branch ? ` sur la branche ${branch}` : ''}:**\n\n` +
                `**Auteur:** ${commit.author}\n` +
                `**Nom du commit:** ${commit.message}\n` +
                `**Date:** ${summaryResult.formattedDate}\n\n` +
                `${summaryResult.summary}`
            );
        }
        else if (commandName === 'resume_commit') {
            const commitMessage = options.getString('commit');
            const branch = options.getString('branch');
            
            const commit = await findCommitByMessage(commitMessage, branch);
            
            if (!commit) {
                return interaction.editReply(`Aucun commit contenant "${commitMessage}" n'a été trouvé${branch ? ` sur la branche ${branch}` : ''}.`);
            }
            
            const summaryResult = await generateCommitSummary(commit, branch);
            
            await interaction.editReply(
                `**Résumé du commit "${commit.message}"${branch ? ` sur la branche ${branch}` : ''}:**\n\n` +
                `**Auteur:** ${commit.author}\n` +
                `**SHA:** ${commit.sha.substring(0, 7)}\n` +
                `**Date:** ${summaryResult.formattedDate}\n\n` +
                `${summaryResult.summary}`
            );
        }
        else if (commandName === 'info_repo') {
            // Rafraîchir les informations du repo
            repoContext = await fetchRepoInfo();
            
            await interaction.editReply(`**Informations sur le dépôt ${repoContext.name}:**\n\n` +
                `📝 Description: ${repoContext.description || 'Aucune description'}\n` +
                `🌿 Branche par défaut: ${repoContext.default_branch}\n` +
                `🔄 Dernière mise à jour des informations: ${new Date(repoContext.lastUpdated).toLocaleString()}`);
        }
        else if (commandName === 'contenu_fichier') {
            const path = options.getString('chemin');
            const branch = options.getString('branch');
            
            const content = await getFileContent(path, branch);
            
            // Si le contenu est trop long pour Discord
            if (content.length > 1900) {
                await interaction.editReply(`Le fichier **${path}** est trop volumineux pour être affiché en entier. Voici les premières lignes:\n\n\`\`\`\n${content.substring(0, 1500)}\n...\n\`\`\``);
            } else {
                await interaction.editReply(`Contenu du fichier **${path}**${branch ? ` (branche: ${branch})` : ''}:\n\n\`\`\`\n${content}\n\`\`\``);
            }
        }
    } catch (error) {
        console.error(`Erreur lors de l'exécution de la commande ${commandName}:`, error);
        await interaction.editReply(`Désolé, une erreur s'est produite lors de l'exécution de cette commande: ${error.message}`);
    }
});

// Gestion des messages
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.content.startsWith(IGNORE_PREFIX)) return;
    if (!CHANNELS.includes(message.channelId) && !message.mentions.users.has(client.user.id)) return;

    await message.channel.sendTyping();
    const sendTypingInterval = setInterval(() => {
        message.channel.sendTyping();
    }, 5000);

    try {
        let conversation = [];
        
        // Instructions système
        conversation.push({
            role: 'system',
            content: `Tu es un assistant IA intégré à Discord nommé ${client.user.username}. 
            
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
            
            Si l'utilisateur demande des informations sur le dépôt GitHub, rappelle-lui qu'il peut utiliser ces commandes ou pose-lui des questions sur GitHub directement.`
        });

        // Récupération du contexte des messages précédents
        let prevMessages = await message.channel.messages.fetch({ limit: 10 });
        prevMessages.reverse();

        prevMessages.forEach((msg) => {
            if (msg.author.bot && msg.author.id !== client.user.id) return;
            if (msg.content.startsWith(IGNORE_PREFIX)) return;

            const username = msg.author.username.replace(/\s+/g, '_').replace(/[^\w\s]/gi, '');

            if (msg.author.id === client.user.id) {
                conversation.push({
                    role: 'assistant',
                    name: username,
                    content: msg.content,
                });
                return;
            }
            
            conversation.push({
                role: "user",
                name: username,
                content: msg.content,
            });
        });

        // Traitement des demandes liées à GitHub
        let userMessage = message.content.toLowerCase();
        
        
        if (userMessage.includes('github') || 
            userMessage.includes('commit') || 
            userMessage.includes('dépôt') || 
            userMessage.includes('repo') || 
            userMessage.includes('branche') ||
            userMessage.includes('branch')) {
            
            
            if (userMessage.includes('resume') && userMessage.includes('dernier commit')) {
                let branch = null;
                
                
                const branchMatch = userMessage.match(/branch\s+(\w+)/i) || userMessage.match(/branche\s+(\w+)/i);
                if (branchMatch && branchMatch[1]) {
                    branch = branchMatch[1];
                }
                
                try {
                    const commit = await getLastCommit(branch);
                    
                    if (commit) {
                        // Ajout des informations du commit au contexte
                        conversation.push({
                            role: 'system',
                            content: `Informations sur le dernier commit${branch ? ` de la branche ${branch}` : ''}:
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
                    // Ajouter une note sur l'erreur
                    conversation.push({
                        role: 'system',
                        content: `Erreur lors de la récupération des informations GitHub: ${error.message}`
                    });
                }
            }
            // Si c'est une demande de résumé d'un commit spécifique
            else if (userMessage.includes('resume') && userMessage.includes('commit')) {
                // Essayer d'extraire le message du commit
                const commitMatch = userMessage.match(/commit\s+[\"\'](.*?)[\"\']/) || // "commit 'message'"
                                   userMessage.match(/commit\s+([^\s]+)/) ||         // "commit message"
                                   userMessage.match(/le\s+commit\s+[\"\'](.*?)[\"\']/) || // "le commit 'message'"
                                   userMessage.match(/le\s+commit\s+([^\s]+)/);       // "le commit message"
                
                if (!commitMatch || !commitMatch[1]) {
                    conversation.push({
                        role: 'system',
                        content: `Je n'ai pas pu identifier le message du commit mentionné. Utilise la commande /resume_commit ou spécifie clairement le message du commit.`
                    });
                } else {
                    const commitMessage = commitMatch[1];
                    
                    
                    let branch = null;
                    const branchMatch = userMessage.match(/branch\s+(\w+)/i) || userMessage.match(/branche\s+(\w+)/i);
                    if (branchMatch && branchMatch[1]) {
                        branch = branchMatch[1];
                    }
                    
                    try {
                        const commit = await findCommitByMessage(commitMessage, branch);
                        
                        if (commit) {
                            // Ajout des informations du commit au contexte
                            conversation.push({
                                role: 'system',
                                content: `Informations sur le commit "${commit.message}"${branch ? ` de la branche ${branch}` : ''}:
                                SHA: ${commit.sha}
                                Message: ${commit.message}
                                Auteur: ${commit.author}
                                Date: ${commit.date}
                                Fichiers modifiés: ${commit.files.length}
                                
                                Détails des modifications:
                                ${JSON.stringify(commit.files, null, 2)}`
                            });
                        } else {
                            conversation.push({
                                role: 'system',
                                content: `Je n'ai pas pu trouver de commit contenant "${commitMessage}"${branch ? ` dans la branche ${branch}` : ''}.`
                            });
                        }
                    } catch (error) {
                        console.error("Erreur lors de la recherche du commit:", error);
                        conversation.push({
                            role: 'system',
                            content: `Erreur lors de la recherche du commit: ${error.message}`
                        });
                    }
                }
            }
        }

        
        const response = await openai.chat.completions.create({
            model: 'gpt-4.1-mini',
            messages: conversation,
        });

        clearInterval(sendTypingInterval);
        
        if (!response) {
            message.reply("Désolé chef ! J'ai des problèmes avec l'API d'OpenAI. Veuillez réessayer dans un moment.");
            return;
        }
        
        const responseMessage = response.choices[0].message.content;
        const chunkSizeLimit = 2000;
        
        for (let i = 0; i < responseMessage.length; i += chunkSizeLimit) {
            const chunk = responseMessage.substring(i, i + chunkSizeLimit);
            await message.reply(chunk);
        }
    } catch (error) {
        clearInterval(sendTypingInterval);
        console.error("Erreur lors du traitement du message:", error);
        message.reply(`Désolé, une erreur s'est produite: ${error.message}`);
    }
});


client.login(process.env.TOKEN);

// Config pour host sur Render
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Bot Discord est actif!');
});

app.listen(PORT, () => {
  console.log(`Serveur web démarré sur le port ${PORT}`);
});