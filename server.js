// 导入所需模块
const express = require('express');
const OpenAI = require('openai');
const dotenv = require('dotenv');
const path = require('path');

// 加载 .env 文件中的环境变量
dotenv.config({ path: 'api_env.env' });

// 初始化 Express 应用
const app = express();
const port = 5000;

// 使用 Express 内置的中间件来解析 JSON 请求体
app.use(express.json());
// 托管 public 目录下的静态文件（如 index.html）
app.use(express.static('public'));

// 初始化 OpenAI 客户端
// 请确保在 api_env.env 文件中设置了 ARK_API_KEY
// 并将 base_url 设置为您的 API 服务地址
const client = new OpenAI({
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: process.env.ARK_API_KEY,
});

// 使用的模型名称
const MODEL_NAME = 'doubao-seed-1-6-250615';

// AI的核心指令 - 发言环节
const SYSTEM_PROMPT = `
你是一个"谁是卧底"游戏的AI玩家。

游戏规则：
- 游戏中有多个玩家，其中一个是“卧底”，其余是“平民”。
- 平民和卧底会拿到相似但不同的词语。
- 你不知道自己的具体身份（是平民还是卧底）。
- 你的目标是：如果你是平民，找出卧底；如果你是卧底，隐藏自己。

发言要求：
1.  **模糊描述**：用一两个词语或短语描述你手中的词语，为了避免暴露，你可以选用一些很宽泛的词语。例如使用“吸水工具”来描述“毛巾”。但**绝对不能**说出词语本身。
2.  **避免重复**：你的描述不能和场上任何一个已经出现过的描述完全重复，但在词义上可以适当重叠。
3.  **隐藏身份**：你的描述要足够巧妙，既能表达你的词语，又不会轻易暴露。
4.  **误导对手（高级技巧）**：如果你猜到自己是卧底，可以尝试描述平民的词语来混淆视听。例如，如果你发现大部分人的描述信息都与你所持词语不匹配，你就应该认真考虑一下自己是不是卧底了。
5.  **胜利至上**：你的最终目标是赢得游戏。

现在是第 {current_round} 轮, 你是 **玩家{player_number}**, 你的词语是 **"{player_word}"**。
场上还剩下这些玩家: {active_players_list}
请参考以下之前的对话历史，给出你这一轮的描述。在你的深度思考过程中，务必不要过度思考。

对话历史:
{previous_conversations}

你的描述:
`;

// AI的核心指令 - 投票环节
const AI_VOTE_PROMPT = `
你是一个"谁是卧底"游戏的AI玩家，现在是投票环节。
你的任务是根据所有人的发言，找出最可疑的玩家并投票给他。

游戏规则回顾:
- 游戏中有“平民”和“卧底”。
- 平民和卧底的词语相似但不同。
- 你的目标是：如果你是平民，找出卧底；如果你是卧底，隐藏自己并误导他人。
- 重要的是，你需要先猜测自己是平民还是卧底，以防闹出乌龙。

现在是投票环节, 你是 **玩家{player_number}**, 你的词语是 **"{player_word}"**。
你不能投自己。你可以投票的玩家编号是: {other_player_ids}

请分析以下所有人的发言历史:
{all_conversations}

如果你实在无法笃定，就投你认为最有可能的那一位，务必不要过度思考。

**注意**，请**直接**给出你的最终决定，例如：“所以我最终投票给玩家X。”
`;


// 全局游戏状态变量
let gameState = {};

/**
 * 初始化一个新的游戏状态。
 * @param {number} totalPlayers - 玩家总数
 * @param {number} numUndercover - 卧底人数
 */
function initializeGame(totalPlayers = 4, numUndercover = 1) {
    const wordPairs = [["牛奶", "豆浆"], ["画家", "作家"], ["手机", "相机"], ["包子", "馒头"], ["薯条", "薯片"], ["毛巾", "手帕"], ["太阳", "月亮"]];
    const selectedPair = wordPairs[Math.floor(Math.random() * wordPairs.length)];
    
    let civilianWord, undercoverWord;
    if (Math.random() > 0.5) {
        [civilianWord, undercoverWord] = selectedPair;
    } else {
        [undercoverWord, civilianWord] = selectedPair;
    }
    
    const numCivilians = totalPlayers - numUndercover;
    let words = Array(numCivilians).fill(civilianWord).concat(Array(numUndercover).fill(undercoverWord));
    // Fisher-Yates shuffle
    for (let i = words.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [words[i], words[j]] = [words[j], words[i]];
    }

    gameState = {
        words,
        undercoverWord,
        civilianWord,
        players: Array.from({ length: totalPlayers }, (_, i) => ({
            id: i + 1,
            name: `AI玩家${i + 1}`,
            role: words[i] !== undercoverWord ? '平民' : '卧底',
            isUndercover: words[i] === undercoverWord,
            word: words[i],
            active: true
        })),
        currentRound: 1,
        discussion: [],
        votes: {},
        gameOver: false,
        winner: null,
        resultMessage: ""
    };
}


/**
 * 格式化并发送 Server-Sent Event (SSE) 数据
 * @param {object} res - Express 的响应对象
 * @param {object} data - 要发送的 JSON 数据
 */
function sendSse(res, data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 从AI生成的文本中解析出投票结果
 * @param {string} text - AI的回复文本
 * @param {number} voterId - 投票者ID
 * @param {number[]} allPlayerIds - 所有存活玩家的ID列表
 * @returns {number|null} - 被投票的玩家ID或随机选择的ID
 */
function parseVoteFromText(text, voterId, allPlayerIds) {
    const possibleTargets = allPlayerIds.filter(id => id !== voterId);
    if (possibleTargets.length === 0) return null;

    let match = text.match(/投票给玩家\s*(\d+)/);
    if (!match) match = text.match(/投给玩家\s*(\d+)/);
    if (!match) match = text.match(/投玩家\s*(\d+)/);
    if (!match) {
        const sentences = text.split(/[。！?]/);
        const lastSentence = sentences[sentences.length - 2] || sentences[0] || '';
        match = lastSentence.match(/玩家\s*(\d+)/);
    }

    if (match) {
        const votedId = parseInt(match[1], 10);
        if (possibleTargets.includes(votedId)) {
            return votedId;
        }
    }

    // 如果无法解析，则随机选择一个
    return possibleTargets[Math.floor(Math.random() * possibleTargets.length)];
}

/**
 * 调用AI模型并以流式方式返回响应
 * @param {string} prompt - 发送给AI的完整提示
 * @returns {AsyncGenerator<object, void, unknown>} - AI响应块的异步生成器
 */
async function* callAIStream(prompt) {
    try {
        if (!process.env.ARK_API_KEY) {
            yield { error: "API key not configured. Please set the ARK_API_KEY environment variable." };
            return;
        }

        const messages = [
            { role: "system", content: "你是一名精通“谁是卧底”游戏的高手。" },
            { role: "user", content: prompt }
        ];

        const stream = await client.chat.completions.create({
            model: MODEL_NAME,
            messages: messages,
            stream: true,
        });

        for await (const chunk of stream) {
            yield chunk;
        }

    } catch (e) {
        console.error(`Error calling AI API: ${e}`);
        yield { error: e.message };
    }
}


/**
 * 处理AI的流式响应并生成SSE事件
 * @param {object} res - Express的响应对象
 * @param {AsyncGenerator<object, void, unknown>} streamGenerator - AI响应流
 * @param {number} playerId - 玩家ID
 * @param {string} playerName - 玩家名称
 * @param {number | null} roundNum - 当前回合数
 * @returns {Promise<string>} - AI完整的回复内容
 */
async function streamAIResponse(res, streamGenerator, playerId, playerName, roundNum = null) {
    let content = "";
    let reasoningContent = "";

    sendSse(res, { type: 'message_start', playerId, name: playerName });

    for await (const chunk of streamGenerator) {
        if (chunk.error) {
            const errorContent = chunk.error;
            sendSse(res, { type: 'message_chunk', content: errorContent });
            content = errorContent;
            break;
        }

        if (chunk.choices[0]?.delta?.reasoning_content) {
            const chunkText = chunk.choices[0].delta.reasoning_content;
            reasoningContent += chunkText;
            sendSse(res, { type: 'reasoning_chunk', reasoning_content: chunkText });
        } else if (chunk.choices[0]?.delta?.content) {
            const chunkText = chunk.choices[0].delta.content || "";
            content += chunkText;
            sendSse(res, { type: 'message_chunk', content: chunkText });
        }
    }

    const discussionEntry = { playerId, name: playerName, content, reasoning: reasoningContent };
    if (roundNum !== null) {
        discussionEntry.round = roundNum;
    }
    gameState.discussion.push(discussionEntry);

    sendSse(res, { type: 'message_end' });
    return content;
}

/**
 * 主游戏循环，通过SSE流式传输游戏事件
 * @param {object} res - Express的响应对象
 * @param {object} settings - 游戏设置
 */
async function streamGameEvents(res, settings) {
    const { total_players, num_undercover, max_rounds } = settings;
    initializeGame(total_players, num_undercover);

    // 1. 发送游戏开始事件
    sendSse(res, { type: 'start', players: gameState.players });
    await new Promise(resolve => setTimeout(resolve, 1000));

    let roundNumber = 1;
    while (!gameState.gameOver) {
        const activePlayers = gameState.players.filter(p => p.active);
        const activePlayerIds = activePlayers.map(p => p.id);
        const activeCivilians = activePlayers.filter(p => !p.isUndercover);
        const activeUndercover = activePlayers.filter(p => p.isUndercover);

        // 2. 检查游戏结束条件
        if (activeUndercover.length === 0) {
            gameState.gameOver = true;
            gameState.winner = "平民";
            gameState.resultMessage = `所有卧底均已被找出，平民获得胜利！卧底词是“${gameState.undercoverWord}”，平民词是“${gameState.civilianWord}”。`;
            sendSse(res, { type: 'end', winner: gameState.winner, result_message: gameState.resultMessage, players: gameState.players, votes: gameState.votes });
            break;
        }
        if (activeUndercover.length >= activeCivilians.length) {
            gameState.gameOver = true;
            gameState.winner = "卧底";
            gameState.resultMessage = `场上卧底人数已占优，卧底自动胜利！卧底词是“${gameState.undercoverWord}”，平民词是“${gameState.civilianWord}”。`;
            sendSse(res, { type: 'end', winner: gameState.winner, result_message: gameState.resultMessage, players: gameState.players, votes: gameState.votes });
            break;
        }
        if (max_rounds > 0 && roundNumber > max_rounds) {
             gameState.gameOver = true;
            gameState.winner = "卧底";
            gameState.resultMessage = `已达到最大回合数 (${max_rounds}轮)，卧底仍未被找出，卧底胜利！卧底词是“${gameState.undercoverWord}”，平民词是“${gameState.civilianWord}”。`;
            sendSse(res, { type: 'end', winner: gameState.winner, result_message: gameState.resultMessage, players: gameState.players, votes: gameState.votes });
            break;
        }

        // 3. 开始新一轮
        gameState.currentRound = roundNumber;
        sendSse(res, { type: 'round_start', round: roundNumber, active_player_ids: activePlayerIds, max_rounds });
        
        // 4. 发言阶段
        const activePlayersListStr = activePlayers.map(p => p.name).join(', ');
        for (const player of activePlayers) {
            const previousConversations = gameState.discussion.map(msg => `${msg.name}: ${msg.content}`).join("\n");
            const prompt = SYSTEM_PROMPT
                .replace('{current_round}', roundNumber)
                .replace('{player_number}', player.id)
                .replace('{player_word}', player.word)
                .replace('{active_players_list}', activePlayersListStr)
                .replace('{previous_conversations}', previousConversations || "现在是第一轮，还没有人发言。");

            const stream = callAIStream(prompt);
            await streamAIResponse(res, stream, player.id, player.name, roundNumber);
        }

        // 5. 投票阶段
        sendSse(res, { type: 'voting_phase_start', round: roundNumber });
        const votes = {};
        const allConversations = gameState.discussion.map(msg => `${msg.name} (第${msg.round}轮): ${msg.content}`).join("\n");

        for (const player of activePlayers) {
            const otherPlayerIds = activePlayerIds.filter(id => id !== player.id);
            const prompt = AI_VOTE_PROMPT
                .replace('{player_number}', player.id)
                .replace('{player_word}', player.word)
                .replace('{other_player_ids}', otherPlayerIds.join(', '))
                .replace('{all_conversations}', allConversations);
            
            const stream = callAIStream(prompt);
            // 投票阶段也需要流式显示思考过程
            const fullResponseContent = await streamAIResponse(res, stream, player.id, player.name, roundNumber);
            
            votes[player.id] = parseVoteFromText(fullResponseContent, player.id, activePlayerIds);
        }
        gameState.votes = votes;

        // 6. 计票与淘汰
        const voteValues = Object.values(votes).filter(v => v !== null);
        if (voteValues.length === 0) {
            sendSse(res, { type: 'tie_vote', message: '本轮无人投票，游戏继续。', votes: votes });
        } else {
            const voteCounts = voteValues.reduce((acc, id) => {
                acc[id] = (acc[id] || 0) + 1;
                return acc;
            }, {});
            
            const maxVotes = Math.max(...Object.values(voteCounts));
            const playersWithMaxVotes = Object.keys(voteCounts).filter(id => voteCounts[id] === maxVotes).map(Number);
            
            if (playersWithMaxVotes.length > 1) {
                 sendSse(res, { type: 'tie_vote', message: `出现平票！玩家 ${playersWithMaxVotes.join(', ')} 均得到了 ${maxVotes} 票。本轮无人出局。`, votes: votes });
            } else {
                const votedOutId = playersWithMaxVotes[0];
                const votedOutPlayer = gameState.players.find(p => p.id === votedOutId);
                if (votedOutPlayer) {
                    votedOutPlayer.active = false;
                    sendSse(res, { type: 'elimination', eliminated_player_id: votedOutId, eliminated_player_name: votedOutPlayer.name, votes: votes });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }
        
        roundNumber++;
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    res.end();
}

// 主页路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 游戏运行路由
app.post('/run_game', (req, res) => {
    // 设置SSE头部
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // 立即发送头部

    let settings = req.body || {};
    let total_players = parseInt(settings.total_players, 10) || 4;
    let num_undercover = parseInt(settings.num_undercover, 10) || 1;
    let max_rounds = parseInt(settings.max_rounds, 10) || 5;
    
    // 服务器端验证
    if (total_players < 3) total_players = 3;
    if (total_players > 10) total_players = 10;
    if (num_undercover < 1) num_undercover = 1;
    if (num_undercover >= total_players / 2) {
        num_undercover = Math.floor(total_players / 2) - 1;
    }
    if (num_undercover < 1) num_undercover = 1;
    if (max_rounds > 20) max_rounds = 20;

    const validatedSettings = { total_players, num_undercover, max_rounds };

    streamGameEvents(res, validatedSettings).catch(err => {
        console.error("Game loop error:", err);
        res.end();
    });

    // 当客户端断开连接时，清理资源
    req.on('close', () => {
        console.log('Client disconnected.');
        res.end();
    });
});

// 启动服务器
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
