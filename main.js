const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware to serve static files
app.use(express.static('public'));
app.use(express.json());

// Function to get a random file from the sets folder
function getRandomSetFile(setType = 'all') {
    const setsDir = path.join(__dirname, 'sets');
    const files = fs.readdirSync(setsDir)
        .filter(file => file.endsWith('.json'))
        .filter(file => {
            if (setType === 'all') return true;
            const isNationals = file.toLowerCase().includes('nationals');
            return setType === 'nationals' ? isNationals : !isNationals;
        });
    
    if (files.length === 0) {
        throw new Error(`No files found for set type: ${setType}`);
    }
    
    const randomFile = files[Math.floor(Math.random() * files.length)];
    return {
        filePath: path.join(setsDir, randomFile),
        fileName: randomFile
    };
}

// Function to get a random question from the selected set
function getRandomQuestion(setFile) {
    const data = JSON.parse(fs.readFileSync(setFile.filePath, 'utf-8'));
    const tossups = data.tossups.filter(tossup => tossup.question && tossup.answer);
    const randomQuestion = tossups[Math.floor(Math.random() * tossups.length)];
    const setName = setFile.fileName.replace('.json', '');
    const pdfLink = `https://www.iacompetitions.com/wp-content/uploads/sites/5/2023/08/${setName}.pdf`;
    return {
    question: randomQuestion.question,
    answer: randomQuestion.answer,
    setName: setName,
    pdfLink: pdfLink
    };
    }

// API endpoint to get a random question
app.get('/api/question', (req, res) => {
    try {
        const setType = req.query.setType || 'all';
        const setFile = getRandomSetFile(setType);
        const question = getRandomQuestion(setFile);
        res.json(question);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route to serve the index.html file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});