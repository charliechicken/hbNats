require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const stringSimilarity = require('string-similarity');
const fetch = require('node-fetch');

// Enable CORS
app.use(cors());

// Serve static files from public directory
app.use(express.static('public'));

// Serve audio files
app.use('/audio', express.static('audio'));

// Add static middleware for root directory files
app.use(express.static(path.join(process.cwd())));

// Add these routes before the WebSocket setup
app.get('/:folder', async (req, res) => {
    const folder = req.params.folder;
    if (folder !== 'sets' && folder !== 'beeSets') {
        return res.status(404).json({ error: 'Folder not found' });
    }

    try {
        // Use absolute path from project root
        const folderPath = path.join(process.cwd(), folder);
        const files = await fs.readdir(folderPath);
        const jsonFiles = files.filter(file => file.endsWith('.json'));
        res.json(jsonFiles);
    } catch (error) {
        console.error(`Error reading ${folder} directory:`, error);
        res.status(500).json({ error: `Failed to read ${folder} directory` });
    }
});

// Add static middleware after the directory listing routes
app.use('/sets', express.static(path.join(process.cwd(), 'sets')));
app.use('/beeSets', express.static(path.join(process.cwd(), 'beeSets')));

// Serve ads.txt from root directory
app.get('/ads.txt', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'ads.txt'));
});

app.get('/api/firebase-config', (req, res) => {
    res.json({
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
});

app.get('/api/qbreader', async (req, res) => {
    try {
        const response = await fetch(`https://qbreader.org/api/query?${req.query}`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('QB Reader proxy error:', error);
        res.status(500).json({ error: 'Failed to fetch from QB Reader' });
    }
});

const server = http.createServer(app);

// Add SSL handling for production
if (process.env.NODE_ENV === 'production') {
    const server = https.createServer({
        cert: process.env.SSL_CERT,
        key: process.env.SSL_KEY
    }, app);
}

const wss = new WebSocketServer({ server });

// Single room state
const gameState = {
    players: [],
    currentQuestion: null,
    buzzOrder: [],
    connections: new Set(),
    isAnswering: false,
    revealedWords: [],
    wordIndex: 0,
    currentInterval: null,
    isGameInProgress: false,
    isQuestionEnded: false,
    speed: 800, // Default speed
};

function broadcast(data, excludeWs = null) {
    const playerCount = gameState.players.length;
    wss.clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            if (data.type === 'player-joined' || data.type === 'player-left') {
                client.send(JSON.stringify({
                    ...data,
                    playerCount
                }));
            } else {
                client.send(JSON.stringify(data));
            }
        }
    });
}

async function loadQuestions() {
    try {
        const repositories = ['sets', 'beeSets'];
        let allQuestions = [];
        
        console.log('Starting to load questions...');
        console.log('Current directory:', __dirname);
        
        for (const repo of repositories) {
            const repoPath = path.join(__dirname, repo);
            console.log(`Checking repository: ${repoPath}`);
            
            const files = await fs.readdir(repoPath);
            console.log(`Found ${files.length} files in ${repo}`);
            
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(repoPath, file);
                    console.log(`Reading file: ${filePath}`);
                    
                    const data = await fs.readFile(filePath, 'utf8');
                    const questionSet = JSON.parse(data);
                    
                    if (questionSet && questionSet.tossups && Array.isArray(questionSet.tossups)) {
                        console.log(`Found ${questionSet.tossups.length} questions in ${file}`);
                        const processedQuestions = questionSet.tossups.map(q => ({
                            ...q,
                            setName: file.replace('.json', ''),
                            isBeeset: repo === 'beeSets'
                        }));
                        allQuestions = allQuestions.concat(processedQuestions);
                    } else {
                        console.log(`No valid tossups found in ${file}`);
                    }
                }
            }
        }

        console.log(`Total questions loaded: ${allQuestions.length}`);
        
        if (allQuestions.length === 0) {
            throw new Error('No questions loaded');
        }

        return allQuestions;
    } catch (error) {
        console.error('Error loading questions:', error);
        throw error;
    }
}

async function getRandomQuestion() {
    try {
        const repositories = ['sets', 'beeSets'];
        let allFiles = [];
        
        // Get all JSON files from both directories
        for (const repo of repositories) {
            const folderPath = path.join(process.cwd(), repo);
            const files = await fs.readdir(folderPath);
            const jsonFiles = files
                .filter(file => file.endsWith('.json'))
                .map(file => ({
                    path: path.join(folderPath, file),
                    name: file,
                    repo: repo,
                    download_url: `/${repo}/${file}`
                }));
            allFiles = allFiles.concat(jsonFiles);
        }
        
        if (allFiles.length === 0) {
            throw new Error('No question files found');
        }
        
        // Get random file
        const randomFile = allFiles[Math.floor(Math.random() * allFiles.length)];
        const data = await fs.readFile(randomFile.path, 'utf8');
        const questionSet = JSON.parse(data);
        
        // Get random question from set
        const tossups = questionSet.tossups.filter(q => q.question && q.answer);
        if (tossups.length === 0) {
            throw new Error('No valid questions found in file');
        }
        
        const randomQuestion = tossups[Math.floor(Math.random() * tossups.length)];
        
        // Clean the question text
        const cleanQuestion = randomQuestion.question
            .replace(/<\/?[^>]+(>|$)/g, '') // Remove HTML tags
            .replace(/\s+/g, ' ')           // Normalize whitespace
            .trim();
        
        return {
            ...randomQuestion,
            question: cleanQuestion,
            originalQuestion: randomQuestion.question, // Keep original for scoring
            setName: randomFile.name.replace('.json', ''),
            isBeeset: randomFile.repo === 'beeSets',
            pdfLink: `https://www.iacompetitions.com/wp-content/uploads/sites/5/2023/08/${randomFile.name.replace('.json', '')}.pdf`
        };
    } catch (error) {
        console.error('Error in getRandomQuestion:', error);
        throw error;
    }
}

// Add these utility functions before the WebSocket handling
function calculateSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    return (longer.length - editDistance(longer, shorter)) / longer.length;
}

function editDistance(str1, str2) {
    const matrix = Array(str2.length + 1).fill().map(() => 
        Array(str1.length + 1).fill(0)
    );

    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= str2.length; j++) {
        for (let i = 1; i <= str1.length; i++) {
            if (str1[i-1] === str2[j-1]) {
                matrix[j][i] = matrix[j-1][i-1];
            } else {
                matrix[j][i] = Math.min(
                    matrix[j-1][i-1] + 1, // substitution
                    matrix[j][i-1] + 1,   // insertion
                    matrix[j-1][i] + 1    // deletion
                );
            }
        }
    }
    return matrix[str2.length][str1.length];
}

function checkAllPlayersBuzzed() {
    return gameState.players.length > 0 && gameState.players.every(player => player.hasBuzzed);
}

function checkAllPlayersAnsweredIncorrectly() {
    return gameState.players.length > 0 && 
           gameState.players.every(player => player.hasBuzzed) &&
           gameState.buzzOrder.length === 0 &&
           gameState.isGameInProgress;
}

function calculatePoints(question, revealedWords) {
    try {
        const questionText = revealedWords.join(' ');
        const fullQuestion = question.question;
        
        // If no special markers, return base points
        if (!fullQuestion.includes('(+)') && !fullQuestion.includes('(*)')) {
            return 10;
        }
        
        // Find the actual text positions of markers
        const plusIndex = fullQuestion.indexOf('(+)');
        const starIndex = fullQuestion.indexOf('(*)');
        
        // Calculate buzz position (length of revealed text)
        const buzzPosition = revealedWords.join(' ').length;
        
        // Debug logs
        console.log({
            buzzPosition,
            plusIndex,
            starIndex,
            revealedWords,
            fullQuestion
        });
        
        // Compare buzz position with marker positions
        if (plusIndex !== -1 && buzzPosition < plusIndex) {
            console.log('30 points - buzzed before plus');
            return 30;
        } else if (starIndex !== -1 && buzzPosition < starIndex) {
            console.log('20 points - buzzed before star');
            return 20;
        }
        
        console.log('10 points - buzzed after star');
        return 10;
    } catch (error) {
        console.error('Error calculating points:', error);
        return 10;
    }
}

// Helper function to handle word revealing
function startWordRevealing(gameState) {
    if (gameState.currentInterval) {
        clearInterval(gameState.currentInterval);
    }
    
    gameState.currentInterval = setInterval(() => {
        const words = gameState.currentQuestion.question.split(' ');
        const isLastWord = gameState.wordIndex >= words.length - 1;
        
        // Store the revealed word
        gameState.revealedWords.push(words[gameState.wordIndex]);
        
        broadcast({
            type: 'word-revealed',
            words: gameState.revealedWords,
            isLastWord: isLastWord
        });
        
        if (isLastWord) {
            clearInterval(gameState.currentInterval);
        } else {
            gameState.wordIndex++;
        }
    }, gameState.speed);
}

function normalizeAnswer(answer) {
    if (!answer) return { answers: [], prompts: [] };
    
    const answers = [];
    const prompts = [];
    
    // Convert to lowercase and remove extra spaces
    answer = answer.toLowerCase().trim();
    
    // Extract the main answer (before any parentheses)
    const mainAnswer = answer.split('(')[0].trim();
    answers.push(mainAnswer);
    
    // Extract parenthetical answers
    const parentheticalMatch = answer.match(/\((.*?)\)/g);
    if (parentheticalMatch) {
        parentheticalMatch.forEach(match => {
            const cleanMatch = match.replace(/^\(|\)$/g, '').trim();
            if (cleanMatch.toLowerCase().startsWith('accept')) {
                // Add the accepted answer without the "accept" prefix
                const acceptedAnswer = cleanMatch.replace(/^accept\s+/i, '').trim();
                answers.push(acceptedAnswer);
            }
        });
    }
    
    return {
        answers: [...new Set(answers)]
            .filter(ans => ans && ans.length >= 3)
            .map(ans => ans.replace(/\s+/g, ' ').trim()),
        prompts
    };
}

function checkAnswer(userAnswer, correctAnswer) {
    // Remove "page X" from user answer and normalize
    const normalizedUserInput = userAnswer.toLowerCase().trim()
        .replace(/page\s+\d+/g, '').trim();
        
    const { answers, prompts } = normalizeAnswer(correctAnswer);
    
    console.log('Answer Check:', {
        userAnswer: normalizedUserInput,
        answers,
        prompts
    });

    // Check if answer needs prompting
    if (prompts.some(p => p === normalizedUserInput)) {
        return { needsPrompt: true };
    }

    // Check for correct answer with more lenient matching
    const isCorrect = answers.some(answer => {
        // Remove ALL HTML tags and clean up the answer
        const cleanAnswer = answer.replace(/<\/?[^>]+(>|$)/g, '').toLowerCase().trim();
        
        // Remove special characters and normalize spaces
        const normalizedAnswer = cleanAnswer.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const normalizedUser = normalizedUserInput.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        
        // Split into words for the full answer
        const answerWords = normalizedAnswer.split(/\s+/);
        const userWords = normalizedUser.split(/\s+/);
        
        // Check if user's answer matches any complete word in the answer
        return userWords.every(userWord => 
            answerWords.some(answerWord => 
                userWord === answerWord || 
                (userWord.length > 3 && answerWord.includes(userWord))
            )
        );
    });

    console.log('Final answer check result:', { isCorrect });
    return { isCorrect };
}

wss.on('connection', (ws) => {
    let username = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'join':
                    username = data.username;
                    gameState.players.push({
                        username,
                        score: 0,
                        hasBuzzed: false
                    });
                    gameState.connections.add(ws);
                    
                    // Send current game state to joining player
                    ws.send(JSON.stringify({
                        type: 'joined',
                        players: gameState.players,
                        currentState: {
                            fullQuestion: gameState.currentQuestion?.question || '',
                            answer: gameState.currentQuestion?.answer || '',
                            setName: gameState.currentQuestion?.setName || '',
                            category: gameState.currentQuestion?.category || '',
                            pdfLink: gameState.currentQuestion?.pdfLink || '',
                            isGameInProgress: gameState.isGameInProgress,
                            isAnswering: gameState.isAnswering,
                            revealedWords: gameState.revealedWords
                        }
                    }));
                    
                    // Broadcast player joined to others
                    broadcast({
                        type: 'player-joined',
                        players: gameState.players
                    }, ws);
                    break;

                case 'start-game':
                    if (!gameState.currentQuestion) {
                        gameState.isGameInProgress = true;
                        const question = await getRandomQuestion();
                        gameState.currentQuestion = question;
                        gameState.revealedWords = [];
                        gameState.wordIndex = 0;
                        gameState.buzzOrder = [];
                        gameState.isAnswering = false;

                        broadcast({
                            type: 'game-started',
                            question
                        });

                        startWordRevealing(gameState);
                    }
                    break;

                case 'buzz':
                    const player = gameState.players.find(p => p.username === username);
                    if (!player.hasBuzzed && gameState.isGameInProgress) {
                        gameState.isAnswering = true;
                        clearInterval(gameState.currentInterval);
                        gameState.buzzOrder.push(username);
                        
                        // Store the revealed text from client
                        gameState.buzzPosition = data.revealedText ? data.revealedText.length : 0;
                        
                        gameState.players = gameState.players.map(p => ({
                            ...p,
                            hasBuzzed: p.username === username ? true : p.hasBuzzed
                        }));

                        broadcast({
                            type: 'game-state',
                            players: gameState.players,
                            isGameInProgress: gameState.isGameInProgress,
                            revealedWords: gameState.revealedWords
                        });

                        broadcast({
                            type: 'buzz',
                            username: username,
                            players: gameState.players
                        });
                    }
                    break;

                case 'submit-answer':
                    if (gameState.isAnswering && gameState.buzzOrder[0] === username) {
                        const userAnswer = data.answer.toLowerCase().trim();
                        const result = checkAnswer(userAnswer, gameState.currentQuestion.answer);

                        if (result.isCorrect) {
                            const points = calculatePoints(gameState.currentQuestion, gameState.revealedWords);
                            const playerIndex = gameState.players.findIndex(p => p.username === username);
                            if (playerIndex !== -1) {
                                gameState.players[playerIndex].score = (gameState.players[playerIndex].score || 0) + points;
                            }
                            
                            ws.send(JSON.stringify({
                                type: 'answer-submitted',
                                username,
                                answer: data.answer,
                                correctAnswer: gameState.currentQuestion.answer,
                                fullQuestion: gameState.currentQuestion.question,
                                setName: gameState.currentQuestion.setName,
                                category: gameState.currentQuestion.category,
                                pdfLink: gameState.currentQuestion.pdfLink,
                                isCorrect: true,
                                points,
                                players: gameState.players
                            }));
                        } else {
                            ws.send(JSON.stringify({
                                type: 'answer-submitted',
                                username,
                                answer: data.answer,
                                correctAnswer: gameState.currentQuestion.answer,
                                fullQuestion: gameState.currentQuestion.question,
                                setName: gameState.currentQuestion.setName,
                                category: gameState.currentQuestion.category,
                                pdfLink: gameState.currentQuestion.pdfLink,
                                isCorrect: false,
                                players: gameState.players
                            }));
                        }
                    }
                    break;

                case 'next-question':
                    gameState.isQuestionEnded = false;
                    gameState.isGameInProgress = true;
                    gameState.isAnswering = false;
                    const question = await getRandomQuestion();
                    gameState.currentQuestion = question;
                    gameState.revealedWords = [];
                    gameState.wordIndex = 0;
                    gameState.buzzOrder = [];
                    
                    // Reset all player states
                    gameState.players = gameState.players.map(p => ({
                        ...p,
                        hasBuzzed: false
                    }));

                    // First broadcast reset state to all clients
                    broadcast({
                        type: 'reset-game-state',
                        players: gameState.players
                    });

                    // Then broadcast new game state
                    broadcast({
                        type: 'game-started',
                        question
                    });

                    startWordRevealing(gameState);
                    break;

                case 'speed-change':
                    gameState.speed = data.speed;
                    // Broadcast speed change to all clients
                    broadcast({
                        type: 'speed-changed',
                        speed: data.speed
                    });
                    
                    // If there's an active interval, restart it with new speed
                    if (gameState.currentInterval) {
                        clearInterval(gameState.currentInterval);
                        startWordRevealing(gameState);
                    }
                    break;

                case 'request-game-state':
                    if (gameState.isGameInProgress) {
                        // Send current game state to the reconnected client
                        ws.send(JSON.stringify({
                            type: 'game-started',
                            question: gameState.currentQuestion
                        }));
                        
                        ws.send(JSON.stringify({
                            type: 'game-state',
                            isAnswering: gameState.isAnswering,
                            players: gameState.players,
                            isGameInProgress: gameState.isGameInProgress,
                            revealedWords: gameState.revealedWords
                        }));
                        
                        // If words are being revealed, restart the process
                        if (gameState.currentInterval) {
                            startWordRevealing(gameState);
                        }
                    }
                    break;

                case 'question-ended':
                    if (!gameState.isQuestionEnded) {
                        gameState.isQuestionEnded = true;
                        broadcast({
                            type: 'question-ended',
                            fullQuestion: gameState.currentQuestion.question,
                            answer: gameState.currentQuestion.answer,
                            setName: gameState.currentQuestion.setName,
                            category: gameState.currentQuestion.category,
                            pdfLink: gameState.currentQuestion.pdfLink
                        });
                    }
                    break;

                case 'time-expired':
                    if (gameState.isGameInProgress && !gameState.isAnswering) {
                        clearInterval(gameState.currentInterval);
                        gameState.currentInterval = null;
                        
                        broadcast({
                            type: 'time-expired',
                            fullQuestion: gameState.currentQuestion.question,
                            answer: gameState.currentQuestion.answer,
                            setName: gameState.currentQuestion.setName,
                            category: gameState.currentQuestion.category,
                            pdfLink: gameState.currentQuestion.pdfLink
                        });
                    }
                    break;
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    ws.on('close', () => {
        if (username) {
            gameState.players = gameState.players.filter(p => p.username !== username);
            gameState.connections.delete(ws);
            broadcast({
                type: 'player-left',
                players: gameState.players
            });
        }
    });
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 
