const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}${window.location.port ? ':' + window.location.port : ''}`;
let ws;

function connectWebSocket() {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
        console.log('Connected to server');
        // Identify as index page
        ws.send(JSON.stringify({
            type: 'page-identify',
            page: 'index'
        }));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'player-count-update') {
            const playerCount = document.getElementById('multiplayer-count');
            if (playerCount) {
                playerCount.textContent = data.count;
            }
        }
    };
}

document.addEventListener('DOMContentLoaded', connectWebSocket);
