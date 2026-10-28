import { GoogleGenAI } from '@google/genai';
import readline from 'readline';
import 'dotenv/config';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log('--- Chat interactiu amb Gemini (Tradylor) ---');
console.log('Escriu la teva consulta o passa-li codi. Escriu "sortir" per tancar.\n');

async function xat() {
    rl.question('Tu > ', async (input) => {
        if (input.toLowerCase().trim() === 'sortir') {
            console.log('Sessió tancada.');
            rl.close();
            return;
        }

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.8-flash',
                contents: input
            });

            console.log(`\nGemini > ${response.text}\n`);
        } catch (error) {
            console.error('\nError:', error.message, '\n');
        }

        xat();
    });
}

xat();