const axios = require('axios');

require('dotenv').config();

const PORT = process.env.PORT || 3000;

// Initialize axios instance
const apiClient = axios.create({
    baseURL: process.env.API_BASE_URL || 'http://localhost',
    timeout: 5000,
});

async function buildEnvironmentMaps() {
    console.log('--- Initiation Phase 1: Constructing Identity Translation Maps ---');

    // 1. Construct Custom Field Mapping (Source Internal ID -> Standardized Key) 
    const sourceFields = await apiCall(`${BASE_URL}/locations/${SOURCE_LOCATION_ID}/customFields`, 'GET', SOURCE_TOKEN);
    if (sourceFields && sourceFields.customFields) {
        sourceFields.customFields.forEach(field => {
            // Populating dictionary for subsequent payload transformation
            dictCustomFields[field.id] = field.fieldKey; 
        });
    }

    // 2. Construct User Mapping (Matched deterministically by lowercase email) 
    const sourceUsers = await apiCall(`${BASE_URL}/users/search`, 'GET', SOURCE_TOKEN, null, { locationId: SOURCE_LOCATION_ID, limit: 100 });
    const destUsers = await apiCall(`${BASE_URL}/users/search`, 'GET', DEST_TOKEN, null, { locationId: DEST_LOCATION_ID, limit: 100 });
    
    const destUserEmails = {};
    if (destUsers && destUsers.users) {
        destUsers.users.forEach(u => destUserEmails[u.email.toLowerCase()] = u.id);
    }
    if (sourceUsers && sourceUsers.users) {
        sourceUsers.users.forEach(su => {
            const match = destUserEmails[su.email.toLowerCase()];
            if (match) dictUsers[su.id] = match; // Cross-environment user linking
        });
    }

    // 3. Construct Pipeline and Stage Architecture Mapping (Matched by nominal string) 
    const sourcePipelinesRes = await apiCall(`${BASE_URL}/opportunities/pipelines`, 'GET', SOURCE_TOKEN, null, { locationId: SOURCE_LOCATION_ID });
    const destPipelinesRes = await apiCall(`${BASE_URL}/opportunities/pipelines`, 'GET', DEST_TOKEN, null, { locationId: DEST_LOCATION_ID });

    if (sourcePipelinesRes.pipelines && destPipelinesRes.pipelines) {
        sourcePipelinesRes.pipelines.forEach(sp => {
            const dpMatch = destPipelinesRes.pipelines.find(dp => dp.name.toLowerCase() === sp.name.toLowerCase());
            if (dpMatch) {
                dictPipelines[sp.id] = dpMatch.id;
                // Deep mapping of nested stages within the matched pipeline
                sp.stages.forEach(ss => {
                    const dsMatch = dpMatch.stages.find(ds => ds.name.toLowerCase() === ss.name.toLowerCase());
                    if (dsMatch) dictStages[ss.id] = dsMatch.id;
                });
            }
        });
    }
    console.log('Identity mapping algorithms complete. Execution proceeding to extraction.');
}

async function migrateContacts() {
    console.log('--- Operational Phase 2: Executing Contact Migration ---');
    let hasMore = true;
    let startAfterId = undefined; // Memory cursor for precise pagination 
    let totalMigrated = 0;

    while (hasMore) {
        const params = { locationId: SOURCE_LOCATION_ID, limit: 100 };
        if (startAfterId) params.startAfterId = startAfterId; // Inject cursor if loop has iterated

        // Extract source contacts batch 
        const response = await apiCall(`${BASE_URL}/contacts/search`, 'GET', SOURCE_TOKEN, null, params);
        const contacts = response.contacts || [];

        // Break loop when dataset exhausts
        if (contacts.length === 0) {
            hasMore = false;
            break;
        }

        for (const contact of contacts) {
            // Algorithmically transform the Custom Fields array schema 
            const transformedCustomFields = [];
            if (contact.customFields) {
                contact.customFields.forEach(cf => {
                    const key = dictCustomFields[cf.id];
                    if (key) {
                        transformedCustomFields.push({
                            key: key,
                            field_value: cf.value
                        });
                    }
                });
            }

            // Construct strictly validated Upsert Payload 
            const payload = {
                locationId: DEST_LOCATION_ID, // Target constraint enforcement
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
                dndSettings: contact.dndSettings || undefined, // Maintain compliance standards
                tags: contact.tags || [],
                customFields: transformedCustomFields,
                createNewIfDuplicateAllowed: false // Enforce deduplication behavior
            };

            // Inject remapped User Assignment if correlation exists 
            if (contact.assignedTo && dictUsers) {
                payload.assignedTo = dictUsers;
            }

            try {
                // Execute Upsert operation against Snapshot Felipe 
                const upsertRes = await apiCall(`${BASE_URL}/contacts/upsert`, 'POST', DEST_TOKEN, payload);
                if (upsertRes && upsertRes.contact && upsertRes.contact.id) {
                    // Critical: Record successful migration correlation in memory dictionary
                    // This creates the bridge for the Opportunity migration phase 
                    dictContacts[contact.id] = upsertRes.contact.id;
                    totalMigrated++;
                }
            } catch (error) {
                console.error(`Upsert failure for contact payload: ${contact.email || contact.id}`);
            }
        }

        // Dynamically update pagination cursor to the ID of the final contact in the array 
        startAfterId = contacts[contacts.length - 1].id;
    }
    console.log(`Contact migration fully concluded. Processed entity count: ${totalMigrated}`);
}


async function migrateOpportunities() {
    console.log('--- Operational Phase 3: Executing Opportunity Migration ---');
    let hasMore = true;
    let page = 1; // Alternative offset pagination tracker 
    let totalMigrated = 0;

    while (hasMore) {
        // Extract source opportunities batch 
        const params = { location_id: SOURCE_LOCATION_ID, limit: 100, page: page };
        const response = await apiCall(`${BASE_URL}/opportunities/search`, 'GET', SOURCE_TOKEN, null, params);
        const opportunities = response.opportunities || [];

        if (opportunities.length === 0) {
            hasMore = false;
            break;
        }

        for (const opp of opportunities) {
            // Validate all fundamental foreign keys exist in destination memory context
            const newContactId = dictContacts[opp.contactId];
            const newPipelineId = dictPipelines[opp.pipelineId];
            
            // Architectural fail-safe: Terminate operation for this record if dependencies are unmapped 
            if (!newContactId ||!newPipelineId) {
                console.warn(`Bypassing Opportunity ${opp.id}: Dependency validation failed (Missing Contact or Pipeline correlation).`);
                continue;
            }

            // Construct strictly validated Upsert Payload 
            const payload = {
                locationId: DEST_LOCATION_ID,
                contactId: newContactId,
                pipelineId: newPipelineId,
                name: opp.name || 'Migrated Opportunity',
                status: opp.status || 'open',
                monetaryValue: opp.monetaryValue || 0
            };

            // Conditionally append stage and assignment only if verified mappings exist 
            if (opp.pipelineStageId && dictStages) {
                payload.pipelineStageId = dictStages;
            }
            if (opp.assignedTo && dictUsers) {
                payload.assignedTo = dictUsers;
            }

            try {
                // Execute Upsert operation against Snapshot Felipe 
                await apiCall(`${BASE_URL}/opportunities/upsert`, 'POST', DEST_TOKEN, payload);
                totalMigrated++;
            } catch (error) {
                console.error(`Upsert failure for opportunity payload: ${opp.name}`);
            }
        }
        
        // Handle metadata cursor for pagination progression 
        if (response.meta && response.meta.nextPageUrl) {
            page++;
        } else {
            hasMore = false;
        }
    }
    console.log(`Opportunity migration fully concluded. Processed entity count: ${totalMigrated}`);
}

// Master Execution Orchestrator
async function main() {
    try {
        console.log('Initiating Cross-Location Migration Sequence...');
        await buildEnvironmentMaps();
        await migrateContacts();
        await migrateOpportunities();
        console.log('Migration Sequence Achieved Full Completion.');
    } catch (error) {
        console.error('Fatal Thread Error detected during master migration execution.', error);
        process.exit(1);
    }
}

// Initialize Sequence Execution
main();

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