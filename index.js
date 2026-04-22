require('dotenv').config();
const axios = require('axios');

const SOURCE_LOCATION_ID = process.env.LUCRA_CRM_LOCATION_ID;
const DEST_LOCATION_ID = process.env.SNAPSHOT_FELIPE_LOCATION_ID;
const SOURCE_TOKEN = `Bearer ${process.env.LUCRA_CRM_AUTH_TOKEN}`;
const DEST_TOKEN = `Bearer ${process.env.SNAPSHOT_FELIPE_AUTH_TOKEN}`;
const API_VERSION = '2021-07-28';
const BASE_URL = 'https://services.leadconnectorhq.com';

const dictUsers = {};
const dictPipelines = {};
const dictStages = {};
const dictContacts = {};
const dictCustomFields = {};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function apiCall(url, method, token, data = null, params = null) {
    let retries = 3;
    while (retries > 0) {
        try {
            await sleep(125);
            const config = {
                method,
                url,
                headers: {
                    'Authorization': token,
                    'Version': API_VERSION,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                params
            };

            if (method.toUpperCase() !== 'GET' && data) {
                config.data = data;
            }

            const response = await axios(config);
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.warn('Rate limit hit. Waiting 5 seconds...');
                await sleep(5000);
                retries--;
            } else {
                console.error(`API Error on ${url}:`, error.response?.data || error.message);
                throw error;
            }
        }
    }
    throw new Error('Maximum API retry threshold exceeded');
}


async function buildEnvironmentMaps() {
    console.log('--- Phase 1: Building Identity Maps ---');

    const sourceFields = await apiCall(`${BASE_URL}/locations/${SOURCE_LOCATION_ID}/customFields`, 'GET', SOURCE_TOKEN);
    if (sourceFields && sourceFields.customFields) {
        sourceFields.customFields.forEach(field => {
            dictCustomFields[field.id] = field.fieldKey;
        });
    }

    const sourceUsers = await apiCall(`${BASE_URL}/users/search`, 'GET', SOURCE_TOKEN, null, { locationId: SOURCE_LOCATION_ID, limit: 100 });
    const destUsers = await apiCall(`${BASE_URL}/users/search`, 'GET', DEST_TOKEN, null, { locationId: DEST_LOCATION_ID, limit: 100 });

    const destUserEmails = {};
    if (destUsers && destUsers.users) {
        destUsers.users.forEach(u => destUserEmails[u.email.toLowerCase()] = u.id);
    }
    if (sourceUsers && sourceUsers.users) {
        sourceUsers.users.forEach(su => {
            const match = destUserEmails[su.email.toLowerCase()];
            if (match) dictUsers[su.id] = match;
        });
    }

    const sourcePipelinesRes = await apiCall(`${BASE_URL}/opportunities/pipelines`, 'GET', SOURCE_TOKEN, null, { locationId: SOURCE_LOCATION_ID });
    const destPipelinesRes = await apiCall(`${BASE_URL}/opportunities/pipelines`, 'GET', DEST_TOKEN, null, { locationId: DEST_LOCATION_ID });

    if (sourcePipelinesRes.pipelines && destPipelinesRes.pipelines) {
        sourcePipelinesRes.pipelines.forEach(sp => {
            const dpMatch = destPipelinesRes.pipelines.find(dp => dp.name.toLowerCase() === sp.name.toLowerCase());
            if (dpMatch) {
                dictPipelines[sp.id] = dpMatch.id;
                sp.stages.forEach(ss => {
                    const dsMatch = dpMatch.stages.find(ds => ds.name.toLowerCase() === ss.name.toLowerCase());
                    if (dsMatch) dictStages[ss.id] = dsMatch.id;
                });
            }
        });
    }
    console.log('Identity mapping complete.');
}

async function migrateContacts() {
    console.log('--- Phase 2: Migrating Contacts ---');
    let hasMore = true;
    let startAfterId = undefined;
    let totalMigrated = 0;

    while (hasMore) {
        const params = { locationId: SOURCE_LOCATION_ID, limit: 100 };
        if (startAfterId) params.startAfterId = startAfterId;

        const response = await apiCall(`${BASE_URL}/contacts/search`, 'GET', SOURCE_TOKEN, null, params);
        const contacts = response.contacts || [];

        if (contacts.length === 0) {
            hasMore = false;
            break;
        }

        for (const contact of contacts) {
            const transformedCustomFields = [];
            if (contact.customFields) {
                contact.customFields.forEach(cf => {
                    const key = dictCustomFields[cf.id];
                    if (key) {
                        transformedCustomFields.push({ key: key, field_value: cf.value });
                    }
                });
            }

            const payload = {
                locationId: DEST_LOCATION_ID,
                firstName: contact.firstName || undefined,
                lastName: contact.lastName || undefined,
                name: contact.name || undefined,
                email: contact.email || undefined,
                phone: contact.phone || undefined,
                address1: contact.address1 || undefined,
                city: contact.city || undefined,
                state: contact.state || undefined,
                postalCode: contact.postalCode || undefined,
                country: contact.country || undefined,
                timezone: contact.timezone || undefined,
                website: contact.website || undefined,
                dnd: contact.dnd || false,
                dndSettings: contact.dndSettings || undefined,
                tags: contact.tags || [],
                customFields: transformedCustomFields,
                createNewIfDuplicateAllowed: false
            };

            if (contact.assignedTo && dictUsers[contact.assignedTo]) {
                payload.assignedTo = dictUsers[contact.assignedTo];
            }

            try {
                const upsertRes = await apiCall(`${BASE_URL}/contacts/upsert`, 'POST', DEST_TOKEN, payload);
                if (upsertRes && upsertRes.contact && upsertRes.contact.id) {
                    dictContacts[contact.id] = upsertRes.contact.id;
                    totalMigrated++;
                }
            } catch (error) {
                console.error(`Upsert failure for contact: ${contact.email || contact.id}`);
            }
        }

        startAfterId = contacts[contacts.length - 1].id;
    }
    console.log(`Contact migration complete. Total: ${totalMigrated}`);
}

async function migrateOpportunities() {
    console.log('--- Phase 3: Migrating Opportunities ---');
    let hasMore = true;
    let page = 1;
    let totalMigrated = 0;

    while (hasMore) {
        const params = { location_id: SOURCE_LOCATION_ID, limit: 100, page: page };
        const response = await apiCall(`${BASE_URL}/opportunities/search`, 'GET', SOURCE_TOKEN, null, params);
        const opportunities = response.opportunities || [];

        if (opportunities.length === 0) {
            hasMore = false;
            break;
        }

        for (const opp of opportunities) {
            const newContactId = dictContacts[opp.contactId];
            const newPipelineId = dictPipelines[opp.pipelineId];

            if (!newContactId || !newPipelineId) {
                console.warn(`Bypassing Opportunity ${opp.id}: Missing Contact or Pipeline.`);
                continue;
            }

            const payload = {
                locationId: DEST_LOCATION_ID,
                contactId: newContactId,
                pipelineId: newPipelineId,
                name: opp.name || 'Migrated Opportunity',
                status: opp.status || 'open',
                monetaryValue: opp.monetaryValue || 0,
            };

            if (opp.pipelineStageId && dictStages[opp.pipelineStageId]) {
                payload.pipelineStageId = dictStages[opp.pipelineStageId];
            }
            if (opp.assignedTo && dictUsers[opp.assignedTo]) {
                payload.assignedTo = dictUsers[opp.assignedTo];
            }

            try {
                await apiCall(`${BASE_URL}/opportunities/upsert`, 'POST', DEST_TOKEN, payload);
                totalMigrated++;
            } catch (error) {
                console.error(`Upsert failure for opportunity: ${opp.name}`);
            }
        }

        if (response.meta && response.meta.nextPageUrl) {
            page++;
        } else {
            hasMore = false;
        }
    }
    console.log(`Opportunity migration complete. Total: ${totalMigrated}`);
}

async function main() {
    try {
        console.log('Starting Migration...');
        await buildEnvironmentMaps();
        await migrateContacts();
        await migrateOpportunities();
        console.log('Migration Successfully Finished.');
    } catch (error) {
        console.error('Fatal Error:', error);
        process.exit(1);
    }
}

main();