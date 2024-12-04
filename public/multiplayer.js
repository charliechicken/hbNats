const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}${window.location.port ? ':' + window.location.port : ''}`;
let username = '';

let ws;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectDelay = 1000; // Start with 1 second delay
let buzzed = false;

// Game state
const gameState = {
    currentQuestion: null,
    revealedWords: [],
    wordIndex: 0,
    interval: null,
    speed: 400,
    players: [],
    isAnswering: false,
    currentInterval: null,  // Track current interval
    buzzOrder: [],
    gameStartTime: null,
    isDoublePoints: false,
    doublePointsTimeout: null
};

// Check if game was already started when page loads
document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('gameStarted') === 'true') {
        document.getElementById('start-game').style.display = 'none';
    }
});

// Create and add speed control to the page
function addSpeedControl() {
    const speedControl = `
        <div class="control-group mt-3">
            <label for="speed">Reading Speed</label>
            <input type="range" id="speed" min="200" max="800" value="400" class="form-control">
        </div>
    `;
    const controlsDiv = document.querySelector('.controls');
    if (controlsDiv) {
        controlsDiv.insertAdjacentHTML('beforeend', speedControl);
        
        // Only send speed change to server
        document.getElementById('speed').addEventListener('input', (e) => {
            safeSend(JSON.stringify({
                type: 'speed-change',
                speed: parseInt(e.target.value)
            }));
        });
    }
}

// Call this function after the DOM is loaded
document.addEventListener('DOMContentLoaded', addSpeedControl);

function initializeGameState() {
    // Check if game is already in progress
    if (localStorage.getItem('gameStarted') === 'true') {
        document.getElementById('start-game').style.display = 'none';
        document.getElementById('buzz-button').disabled = false;
        
        // Request current game state from server
        safeSend(JSON.stringify({
            type: 'request-game-state',
            username
        }));
    }
}

function connectWebSocket() {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
        console.log('Connected to server');
        if (username) {
            // Re-join the game and get current state
            safeSend(JSON.stringify({
                type: 'join',
                username
            }));
            initializeGameState();
        }
    };

    ws.onclose = () => {
        if (reconnectAttempts < maxReconnectAttempts) {
            console.log(`Connection lost. Reconnecting... (Attempt ${reconnectAttempts + 1})`);
            setTimeout(() => {
                reconnectAttempts++;
                connectWebSocket();
            }, reconnectDelay * Math.pow(2, reconnectAttempts)); // Exponential backoff
        } else {
            showError('Connection lost. Please refresh the page.');
        }
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

// Initialize connection
connectWebSocket();

// Update all ws.send calls to check connection state
function safeSend(message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
    } else {
        showError('Connection lost. Trying to reconnect...');
    }
}

function joinGame() {
    const usernameInput = document.getElementById('username');
    username = usernameInput.value.trim();
    
    if (!username) {
        showError('Please enter a username');
        return;
    }

    safeSend(JSON.stringify({
        type: 'join',
        username
    }));

    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('game-room').style.display = 'block';
}

function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'reset-game-state':
            // Reset local state
            buzzed = false;
            gameState.isAnswering = false;
            
            // Update players list which will clear buzzed states
            updatePlayersList(data.players);
            
            // Reset buzz button
            const buzzButton = document.getElementById('buzz-button');
            if (buzzButton) {
                buzzButton.disabled = false;
                buzzButton.style.opacity = '1';
            }
            break;
        case 'joined':
            updatePlayersList(data.players);
            // Show start button for the first player only
            const startButton = document.getElementById('start-game');
            startButton.style.display = data.players.length === 1 ? 'block' : 'none';
            
            // Handle existing game state for new players
            if (data.currentState?.isGameInProgress) {
                const display = document.getElementById('question-display');
                if (data.currentState.revealedWords.length > 0) {
                    display.textContent = data.currentState.revealedWords.join(' ');
                }
                if (data.currentState.answer) {
                    display.innerHTML = `
                        <div class="full-question mb-3">
                            ${data.currentState.fullQuestion}
                        </div>
                        <div class="alert alert-success">
                            Correct answer: ${data.currentState.answer}
                        </div>
                        <div class="question-info">
                            <p>Set: <a href="${data.currentState.pdfLink}" target="_blank">${data.currentState.setName}</a></p>
                            <p>Category: ${data.currentState.category}</p>
                        </div>
                        <button onclick="startNewGame()" class="btn btn-primary mt-3">Next Question (j)</button>
                    `;
                }
            }
            break;
        case 'player-joined':
        case 'player-left':
            updatePlayersList(data.players);
            break;
        case 'game-started':
            handleGameStart(data);
            break;
        case 'word-revealed':
            handleWordRevealed(data);
            break;
        case 'buzz':
            handleBuzz(data);
            break;
        case 'answer-submitted':
            handleAnswerSubmitted(data);
            break;
        case 'error':
            showError(data.message);
            break;
        case 'game-state':
            handleGameState(data);
            break;
        case 'all-buzzed':
            handleAllBuzzed(data);
            break;
    }
}

function updatePlayersList(players) {
    const playersContainer = document.getElementById('players-container');
    playersContainer.innerHTML = players
        .map(player => `
            <div class="player-item ${player.hasBuzzed ? 'buzzed' : ''}">
                <span>${player.username}</span>
                <span>${player.score || 0} points</span>
            </div>
        `)
        .join('');
}

function handleGameStart(data) {
    // Clear any existing intervals
    if (gameState.currentInterval) {
        clearInterval(gameState.currentInterval);
        gameState.currentInterval = null;
    }
    
    // Hide start button and store in localStorage to persist across refreshes
    document.getElementById('start-game').style.display = 'none';
    localStorage.setItem('gameStarted', 'true');
    
    const buzzButton = document.getElementById('buzz-button');
    if (buzzButton) buzzButton.disabled = false;
    
    gameState.currentQuestion = data.question;
    const display = document.getElementById('question-display');
    display.innerHTML = '';
    
    // Reset game state
    gameState.revealedWords = [];
    gameState.wordIndex = 0;
    gameState.isAnswering = false;
    buzzed = false;
}

function handleWordRevealed(data) {
    // Simply update the display with the words we received
    const display = document.getElementById('question-display');
    if (display) {
        display.textContent = data.words.join(' ');
    }
}

function buzz() {
    if (buzzed) return;  // Only check local state
    
    safeSend(JSON.stringify({
        type: 'buzz',
        username
    }));
}

function handleBuzz(data) {
    // Update game state for ALL clients when someone buzzes
    gameState.isAnswering = true;
    buzzed = data.username === username;
    
    const display = document.getElementById('question-display');
    display.innerHTML += `
        <div class="alert alert-warning mt-3">
            ${data.username} has buzzed in!
        </div>
    `;

    // Disable buzz button for everyone until next question
    const buzzButton = document.getElementById('buzz-button');
    if (buzzButton) {
        buzzButton.disabled = true;
        buzzButton.style.opacity = '0.5';  // Grey out the button
    }

    if (data.username === username) {
        document.getElementById('answer-input').style.display = 'block';
        document.getElementById('answer-input').querySelector('input').focus();
    }
}

function submitAnswer() {
    const answerInput = document.getElementById('answer-input').querySelector('input');
    const answer = answerInput.value.trim();
    
    if (!answer) return;
    
    safeSend(JSON.stringify({
        type: 'submit-answer',
        username,
        answer
    }));
    
    answerInput.value = '';
    document.getElementById('answer-input').style.display = 'none';
}

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'alert alert-danger';
    errorDiv.textContent = message;
    document.querySelector('.container').prepend(errorDiv);
    setTimeout(() => errorDiv.remove(), 5000);
}

function handleGameState(data) {
    // Update local state based on server state
    gameState.isAnswering = data.isAnswering || false;
    gameState.players = data.players;
    
    // Reset local buzz state based on server state
    const currentPlayer = data.players.find(p => p.username === username);
    buzzed = currentPlayer ? currentPlayer.hasBuzzed : false;
    
    // Update buzz button state
    const buzzButton = document.getElementById('buzz-button');
    if (buzzButton) {
        buzzButton.disabled = buzzed || gameState.isAnswering;
    }
}

function handleAnswerSubmitted(data) {
    const display = document.getElementById('question-display');
    updatePlayersList(data.players);
    
    if (data.isCorrect) {
        // Show points popup
        showPointsPopup(data.points, data.username);
        
        display.innerHTML = `
            <div class="full-question mb-3">
                ${data.fullQuestion}
            </div>
            <div class="alert alert-success">
                ${data.username}'s answer: ${data.answer}
                <br>
                Correct! The answer was: ${data.correctAnswer}
            </div>
            <div class="question-info">
                <p>Set: <a href="${data.pdfLink}" target="_blank">${data.setName}</a></p>
                <p>Category: ${data.category}</p>
            </div>
            <button onclick="startNewGame()" class="btn btn-primary mt-3">Next Question (j)</button>
        `;
        
        // Disable buzz button and clear intervals
        const buzzButton = document.getElementById('buzz-button');
        if (buzzButton) {
            buzzButton.disabled = true;
            buzzButton.style.opacity = '0.5';
        }
        if (gameState.currentInterval) {
            clearInterval(gameState.currentInterval);
            gameState.currentInterval = null;
        }
    } else {
        // Keep existing incorrect answer handling
        display.innerHTML += `
            <div class="alert alert-danger">
                ${data.username}'s answer: ${data.answer}
                <br>
                Incorrect - continue reading...
            </div>
        `;
        
        if (username === data.username) {
            buzzed = true;
        } else {
            const buzzButton = document.getElementById('buzz-button');
            if (buzzButton && !buzzed) {
                buzzButton.disabled = false;
                buzzButton.style.opacity = '1';
            }
        }
    }
}

// Add this to handle next question button and 'j' key
document.addEventListener('keydown', (e) => {
    const activeElement = document.activeElement;
    
    // Prevent space from triggering when typing in input
    if (activeElement.tagName === 'INPUT') {
        if (e.code === 'Space') {
            e.stopPropagation();
        } else if (e.code === 'Enter' && !e.repeat) {
            e.preventDefault();
            submitAnswer();
        }
        return;
    }
    
    // Handle space for buzz - simplified condition
    if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        buzz();
    }
    
    // Handle 'j' for next question
    if (e.code === 'KeyJ' && !e.repeat && document.querySelector('[onclick="startNewGame()"]')) {
        startNewGame();
    }
});

function startNewGame() {
    // Reset local state
    buzzed = false;
    
    // Reset all player items to remove buzzed class
    const playerItems = document.querySelectorAll('.player-item');
    playerItems.forEach(item => {
        item.classList.remove('buzzed');
    });
    
    // Re-enable and reset buzz button style
    const buzzButton = document.getElementById('buzz-button');
    if (buzzButton) {
        buzzButton.disabled = false;
        buzzButton.style.opacity = '1';
    }
    
    safeSend(JSON.stringify({
        type: 'next-question',
        username
    }));
}


function showDoublePointsPopup() {
    const popup = document.createElement('div');
    popup.className = 'double-points-popup';
    popup.innerHTML = `
        <div class="double-points-content">
            <h2>⚡ DOUBLE POINTS ACTIVATED! ⚡</h2>
            <p>All points are doubled for the next 30 seconds!</p>
            <div class="timer">30</div>
        </div>
    `;
    document.body.appendChild(popup);
    
    // Start countdown timer
    let timeLeft = 30;
    const timerElement = popup.querySelector('.timer');
    const countdown = setInterval(() => {
        timeLeft--;
        timerElement.textContent = timeLeft;
        if (timeLeft <= 0) {
            clearInterval(countdown);
            popup.classList.add('fade-out');
            setTimeout(() => popup.remove(), 1000);
        }
    }, 1000);
}

// Helper function to calculate string similarity
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

// Event Listeners
document.getElementById('start-game').addEventListener('click', () => {
    document.getElementById('start-game').style.display = 'none';  // Hide immediately
    document.getElementById('buzz-button').disabled = false;  // Enable buzz button
    safeSend(JSON.stringify({
        type: 'start-game',
        username
    }));
});

document.getElementById('buzz-button').addEventListener('click', buzz);

document.addEventListener('keydown', (e) => {
    const activeElement = document.activeElement;
    
    // Prevent space from triggering when typing in input
    if (activeElement.tagName === 'INPUT') {
        if (e.code === 'Space') {
            e.stopPropagation();
        } else if (e.code === 'Enter' && !e.repeat) {
            e.preventDefault();
            submitAnswer();
        }
        return;
    }
    
    // Handle space for buzz - simplified condition
    if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        buzz();
    }
    
    // Handle 'j' for next question
    if (e.code === 'KeyJ' && !e.repeat && document.querySelector('[onclick="startNewGame()"]')) {
        startNewGame();
    }
});

function handleAllBuzzed(data) {
    const display = document.getElementById('question-display');
    display.innerHTML = `
        <div class="full-question mb-3">
            ${data.fullQuestion}
        </div>
        <div class="alert ${data.isCorrect ? 'alert-success' : 'alert-danger'}">
            ${data.username}'s answer: ${data.answer}
            <br>
            ${data.isCorrect ? 'Correct!' : 'Incorrect'}
            <br>
            Correct answer: ${data.correctAnswer}
        </div>
        <div class="question-info">
            <p>Set: <a href="${data.pdfLink}" target="_blank">${data.setName}</a></p>
            <p>Category: ${data.category}</p>
        </div>
        <button onclick="startNewGame()" class="btn btn-primary mt-3">Next Question (j)</button>
    `;

    // Disable buzz button and clear any intervals
    document.getElementById('buzz-button').disabled = true;
    if (gameState.currentInterval) {
        clearInterval(gameState.currentInterval);
        gameState.currentInterval = null;
    }

    // Add keyboard shortcut for next question
    document.addEventListener('keydown', handleNextQuestionShortcut);
}

// Add this function near the other event handlers
function handleNextQuestionShortcut(e) {
    if (e.code === 'KeyJ' && !e.repeat) {
        startNewGame();
        // Remove the event listener after handling
        document.removeEventListener('keydown', handleNextQuestionShortcut);
    }
}

// Add this new function
function showPointsPopup(points, playerName) {
    const popup = document.createElement('div');
    popup.className = 'points-popup';
    
    // Set color based on points
    let backgroundColor;
    if (points === 30) {
        backgroundColor = 'rgba(220, 53, 69, 0.9)';  // Red
    } else if (points === 20) {
        backgroundColor = 'rgba(255, 165, 0, 0.9)';  // Orange
    } else {
        backgroundColor = 'rgba(40, 167, 69, 0.9)';  // Green
    }
    
    popup.style.backgroundColor = backgroundColor;
    popup.innerHTML = `
        <div class="points-content">
            <h3>+${points} Points!</h3>
            <p>${playerName}</p>
        </div>
    `;
    document.body.appendChild(popup);
    
    // Add CSS animation class after a brief delay
    setTimeout(() => popup.classList.add('show'), 10);
    
    // Remove popup after animation
    setTimeout(() => {
        popup.classList.remove('show');
        setTimeout(() => popup.remove(), 500);
    }, 2000);
}
