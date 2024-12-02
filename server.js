const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const port = 3000;

// Serve static files from public directory
app.use(express.static('public'));

// Endpoint to get file listings
app.get('/:folder', (req, res) => {
    const folder = req.params.folder;
    if (folder !== 'sets' && folder !== 'beeSets') {
        return res.status(404).json({ error: 'Folder not found' });
    }

    const folderPath = path.join(__dirname, folder);
    try {
        const files = fs.readdirSync(folderPath)
            .filter(file => file.endsWith('.json'));
        res.json(files);
    } catch (error) {
        res.status(500).json({ error: 'Error reading directory' });
    }
});

// Serve JSON files from sets and beeSets folders
app.use('/sets', express.static('sets'));
app.use('/beeSets', express.static('beeSets'));

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 