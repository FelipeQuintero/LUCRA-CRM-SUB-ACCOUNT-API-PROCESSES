const axios = require('axios');

require('dotenv').config();

const PORT = process.env.PORT || 3000;

// Initialize axios instance
const apiClient = axios.create({
    baseURL: process.env.API_BASE_URL || 'http://localhost',
    timeout: 5000,
});

// Example function 1
async function fetchData() {
    try {
        const response = await apiClient.get('/data');
        console.log('Data fetched:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error fetching data:', error.message);
        throw error;
    }
}

// Example function 2
async function postData(payload) {
    try {
        const response = await apiClient.post('/data', payload);
        console.log('Data posted:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error posting data:', error.message);
        throw error;
    }
}

// Main execution
async function main() {
    try {
        await fetchData();
        await postData({ example: 'data' });
    } catch (error) {
        console.error('Main error:', error);
    }
}

main();