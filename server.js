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

// Enable CORS
app.use(cors());

// Serve static files from public directory
app.use(express.static('public'));

// Serve audio files
app.use('/audio', express.static('audio'));

// Ensure directories exist
async function ensureDirectories() {
    const dirs = ['sets', 'beeSets'];
    for (const dir of dirs) {
        try {
            await fs.access(path.join(__dirname, dir));
        } catch {
            await fs.mkdir(path.join(__dirname, dir));
        }
    }
}

// Call this before setting up routes
ensureDirectories().catch(err => {
    console.error('Error creating directories:', err);
    process.exit(1);
});

// Endpoint to get file listings
app.get('/:folder', async (req, res) => {
    const folder = req.params.folder;
    if (folder !== 'sets' && folder !== 'beeSets') {
        return res.status(404).json({ error: 'Folder not found' });
    }

    const folderPath = path.join(__dirname, '..', folder);
    try {
        const files = await fs.readdir(folderPath);
        const jsonFiles = files.filter(file => file.endsWith('.json'));
        res.json(jsonFiles);
    } catch (error) {
        console.error(`Error reading ${folder} directory:`, error);
        res.status(500).json({ error: `Failed to read ${folder} directory` });
    }
});

app.get('/api/firebase-config', (req, res) => {
    res.json({
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
});

// Serve static JSON files from parent directory
app.use('/sets', express.static(path.join(__dirname, '..', 'sets')));
app.use('/beeSets', express.static(path.join(__dirname, '..', 'beeSets')));

// Directory listing endpoints
app.get('/sets', async (req, res) => {
    try {
        const files = await fs.readdir(path.join(__dirname, '..', 'sets'));
        const jsonFiles = files.filter(file => file.endsWith('.json'));
        res.json(jsonFiles);
    } catch (error) {
        console.error('Error reading sets directory:', error);
        res.status(500).json({ error: 'Failed to read sets directory' });
    }
});

app.get('/beeSets', async (req, res) => {
    try {
        const files = await fs.readdir(path.join(__dirname, '..', 'beeSets'));
        const jsonFiles = files.filter(file => file.endsWith('.json'));
        res.json(jsonFiles);
    } catch (error) {
        console.error('Error reading beeSets directory:', error);
        res.status(500).json({ error: 'Failed to read beeSets directory' });
    }
});

// Individual file endpoints
app.get('/sets/:file', async (req, res) => {
    try {
        const filePath = path.join(__dirname, '..', 'sets', req.params.file);
        const data = await fs.readFile(filePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        console.error('Error reading file:', error);
        res.status(500).json({ error: 'Failed to read question set' });
    }
});

app.get('/beeSets/:file', async (req, res) => {
    try {
        const filePath = path.join(__dirname, '..', 'beeSets', req.params.file);
        const data = await fs.readFile(filePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        console.error('Error reading file:', error);
        res.status(500).json({ error: 'Failed to read question set' });
    }
});

// Serve JSON files from sets and beeSets folders
app.get('/:folder/:file', async (req, res) => {
    const { folder, file } = req.params;
    if (folder !== 'sets' && folder !== 'beeSets') {
        return res.status(404).json({ error: 'Folder not found' });
    }

    try {
        const filePath = path.join(__dirname, '..', folder, file);
        const data = await fs.readFile(filePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        console.error(`Error reading file from ${folder}:`, error);
        res.status(500).json({ error: `Failed to read file from ${folder}` });
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
    isGameInProgress: false
};

function broadcast(message) {
    gameState.connections.forEach(client => {
        if (client.readyState === client.OPEN) {
            client.send(JSON.stringify(message));
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
            const repoPath = path.join(__dirname, repo);
            const files = await fs.readdir(repoPath);
            const jsonFiles = files.filter(file => file.endsWith('.json'))
                .map(file => ({
                    path: path.join(repoPath, file),
                    name: file,
                    repo: repo
                }));
            allFiles = allFiles.concat(jsonFiles);
        }
        
        // Get random file
        const randomFile = allFiles[Math.floor(Math.random() * allFiles.length)];
        const data = await fs.readFile(randomFile.path, 'utf8');
        const questionSet = JSON.parse(data);
        
        // Get random question from set
        const tossups = questionSet.tossups.filter(q => q.question && q.answer);
        const randomQuestion = tossups[Math.floor(Math.random() * tossups.length)];
        
        if (!randomQuestion) {
            throw new Error('No valid question found');
        }
        
        const setName = randomFile.name.replace('.json', '');
        
        return {
            question: randomQuestion.question.replace(/<[^>]+>/g, ''),
            answer: randomQuestion.answer,
            category: randomQuestion.metadata || 'Unknown',
            setName: setName,
            pdfLink: `https://www.iacompetitions.com/wp-content/uploads/sites/5/2023/08/${setName}.pdf`
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
        
        // Debug logs
        console.log('Calculating points:');
        console.log('Current text length:', questionText.length);
        console.log('Plus index:', fullQuestion.indexOf('(+)'));
        console.log('Star index:', fullQuestion.indexOf('(*)'));
        
        // If no special markers, return base points
        if (!fullQuestion.includes('(+)') && !fullQuestion.includes('(*)')) {
            console.log('No markers found, returning 10 points');
            return 10;
        }
        
        const plusIndex = fullQuestion.indexOf('(+)');
        const starIndex = fullQuestion.indexOf('(*)');
        const currentPosition = questionText.length;
        
        if (plusIndex === -1 || currentPosition < plusIndex) {
            console.log('Before plus marker, returning 30 points');
            return 30;
        } else if (starIndex === -1 || currentPosition < starIndex) {
            console.log('Before star marker, returning 20 points');
            return 20;
        }
        console.log('After all markers, returning 10 points');
        return 10;
    } catch (error) {
        console.error('Error calculating points:', error);
        return 10; // Default to 10 points on error
    }
}

// Helper function to handle word revealing
function startWordRevealing(gameState, speed = 400) {
    // Clear any existing interval first
    if (gameState.currentInterval) {
        clearInterval(gameState.currentInterval);
        gameState.currentInterval = null;
    }
    
    const words = gameState.currentQuestion.question.split(/\s+/);
    gameState.isAnswering = false;  // Make sure to reset answering state
    
    gameState.currentInterval = setInterval(() => {
        if (gameState.wordIndex < words.length && !gameState.isAnswering) {
            gameState.revealedWords.push(words[gameState.wordIndex]);
            gameState.wordIndex++;
            
            broadcast({
                type: 'word-revealed',
                words: gameState.revealedWords
            });
        } else {
            clearInterval(gameState.currentInterval);
            gameState.currentInterval = null;
        }
    }, speed);
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

                        startWordRevealing(gameState, 400);
                    }
                    break;

                case 'buzz':
                    const player = gameState.players.find(p => p.username === username);
                    if (!player.hasBuzzed && gameState.isGameInProgress) {
                        gameState.isAnswering = true;
                        clearInterval(gameState.currentInterval);
                        gameState.buzzOrder.push(username);
                        
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
                        const fullAnswer = gameState.currentQuestion.answer
                            .replace(/<\/?[bu]>/g, '')  // Remove all <b> and <u> tags
                            .toLowerCase()
                            .trim();
                        
                        // Check if user's answer is included in the full answer
                        const isCorrect = fullAnswer.includes(userAnswer);

                        if (isCorrect) {
                            // Calculate points
                            const points = calculatePoints(gameState.currentQuestion, gameState.revealedWords);
                            
                            // Update player score
                            gameState.players = gameState.players.map(p => ({
                                ...p,
                                score: p.username === username ? (p.score || 0) + points : p.score
                            }));

                            // Broadcast correct answer to all players
                            broadcast({
                                type: 'answer-submitted',
                                username,
                                answer: data.answer,
                                correctAnswer: gameState.currentQuestion.answer,
                                fullQuestion: gameState.currentQuestion.question,
                                setName: gameState.currentQuestion.setName,
                                category: gameState.currentQuestion.category,
                                pdfLink: gameState.currentQuestion.pdfLink,
                                isCorrect: true,
                                points: points,
                                players: gameState.players
                            });
                        } else {
                            // Keep existing incorrect answer handling
                            gameState.isAnswering = false;
                            gameState.buzzOrder = gameState.buzzOrder.filter(u => u !== username);
                            
                            // Update hasBuzzed state for the current player
                            gameState.players = gameState.players.map(p => ({
                                ...p,
                                hasBuzzed: p.username === username ? true : p.hasBuzzed
                            }));

                            // Check if all players have answered incorrectly
                            if (checkAllPlayersAnsweredIncorrectly()) {
                                broadcast({
                                    type: 'all-buzzed',
                                    fullQuestion: gameState.currentQuestion.question,
                                    answer: gameState.currentQuestion.answer,
                                    correctAnswer: gameState.currentQuestion.answer,
                                    username: username,
                                    answer: data.answer,
                                    isCorrect: false,
                                    setName: gameState.currentQuestion.setName,
                                    category: gameState.currentQuestion.category,
                                    pdfLink: gameState.currentQuestion.pdfLink
                                });
                            } else {
                                broadcast({
                                    type: 'game-state',
                                    isAnswering: false,
                                    players: gameState.players,
                                    isGameInProgress: gameState.isGameInProgress,
                                    revealedWords: gameState.revealedWords
                                });
                                
                                broadcast({
                                    type: 'answer-submitted',
                                    username: username,
                                    answer: data.answer,
                                    correctAnswer: gameState.currentQuestion.answer,
                                    isCorrect: false,
                                    players: gameState.players
                                });

                                startWordRevealing(gameState, data.speed || 400);
                            }
                        }
                    }
                    break;

                case 'next-question':
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

                    startWordRevealing(gameState, 400);
                    break;

                case 'speed-change':
                    if (gameState.currentInterval) {
                        startWordRevealing(gameState, data.speed);
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
                            startWordRevealing(gameState, gameState.speed || 400);
                        }
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
