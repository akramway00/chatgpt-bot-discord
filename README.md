# ChatGPT Discord Bot with GitHub Integration

A Node.js-based Discord bot powered by OpenAI and GitHub APIs. This bot is designed to provide intelligent conversational responses, summarize Git commits, and interact with a GitHub repository directly from a Discord channel.

## 🔧 Features

- 💬 **ChatGPT Integration**: Chat directly with a GPT-4-based assistant in Discord.
- 🧠 **Contextual Responses**: Includes message history and GitHub context for accurate replies.
- 🔍 **GitHub Repo Access**: Automatically retrieves and summarizes commit history.
- 📄 **File Content Display**: Reads and displays file content from any branch.
- ✅ **Slash Commands Support**:
  - `/resume_last_commit [branch]` – Summarize the latest commit.
  - `/resume_commit [commit] [branch]` – Summarize a specific commit.
  - `/info_repo` – Get general repository information.
  - `/contenu_fichier [path] [branch]` – Display file content.

## 🚀 Getting Started

### Prerequisites

- Node.js v18+
- A Discord bot token
- OpenAI API key
- GitHub personal access token

### Installation

```bash
git clone https://github.com/akrm00/chatgpt-bot-discord.git
cd chatgpt-bot-discord
npm install
```

### Environment Variables

Create a `.env` file at the root with the following variables:

```env
TOKEN=your_discord_bot_token
OPENAI_KEY=your_openai_api_key
GITHUB_TOKEN=your_github_pat
GITHUB_OWNER=github_repo_owner
GITHUB_REPO=repository_name
PORT=10000
```

## 🛠 Usage

```bash
node index.js
```

Once the bot is running:
- Interact via Discord in whitelisted channels.
- Mention the bot or use slash commands for GitHub actions.

## 📦 Technologies Used

- [Discord.js v14](https://discord.js.org/)
- [OpenAI Node SDK](https://github.com/openai/openai-node)
- [Octokit (GitHub API)](https://github.com/octokit/rest.js)
- [Express](https://expressjs.com/)

## 📁 Project Structure

- `index.js` — Main server and bot logic
- `.env` — Environment config (not committed)

## 📜 License

This project is licensed under the MIT License.

---

*Built by [akrm00](https://github.com/akrm00)
