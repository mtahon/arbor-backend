const Web3 = require('web3');
const _ = require('lodash');
const chalk = require('chalk');
const {
    waitForBlockNumber,
    createResolver,
    getTrustAssertsion,
    getCurrentBlockNumber,
    checkSslByUrl
} = require('./utils');

// Web3 Connection Guard
const connectionGuard = require('./guard');

const log = require('log4js').getLogger('smart_contracts_connector');
log.level = 'debug';

// Constants
const orgid0x = '0x0000000000000000000000000000000000000000000000000000000000000000';

module.exports = (config, cached) => {
    const { currentEnvironment, environments } = config();
    const environment = environments[currentEnvironment]; 

    let web3;
    let orgIdResolver;
    let orgidContract;
    let eventsSubscription;

    // Start connection for events listener with guard
    connectionGuard(
        `wss://${environment.network}.infura.io/ws/v3/${environment.infuraId}`,
        // Diconnection handler
        () => {},
        // Connection handler
        async _web3 => {
            try {
                web3 = _web3;
                orgIdResolver = createResolver(
                    web3,
                    environment.orgidAddress
                );
                orgidContract = await orgIdResolver.getOrgIdContract();
                eventsSubscription = listenEvents(web3, orgidContract, orgIdResolver);
            } catch (error) {
                log.error('Before subscribe:', error)
            }
        }
    );
    
    // Start Listening on all OrgId contract Events
    const listenEvents = async (web3, orgidContract, orgIdResolver) => {

        try {
            const lastKnownBlockNumber = await cached.getBlockNumber();
            log.debug(`Subscribing to events of Orgid ${chalk.grey(`at address: ${orgidContract}`)}`);

            const subscription = orgidContract.events
                .allEvents({ 
                    fromBlock: lastKnownBlockNumber - 10
                })

                // Connection established
                .on('connected', subscriptionId => {
                    log.debug(`Connected with ${subscriptionId}`);
                })

                // Event Received
                .on(
                    'data',
                    event => resolveOrgidEvent(
                        web3,
                        orgidContract,
                        orgIdResolver,
                        event
                    )
                )

                // Change event
                .on('changed', event => log.debug("=================== Changed ===================\r\n", event))

                // Error Event
                .on('error', error => log.debug("=================== ERROR ===================\r\n", error));
            
            log.debug(`Events listening started ${chalk.grey(`from block ${lastKnownBlockNumber}`)}`);            
            
            return subscription;
        } catch (error) {
            log.error('Error during listenEvents', error.toString());
        }
    };

    // Process the event
    const resolveOrgidEvent = async (web3, orgidContract, orgIdResolver, event) => {
        log.debug(`=================== :EVENT: ${event.event} : ===================`);

        try {
            const currentBlockNumber = await getCurrentBlockNumber(web3);
            
            log.debug(event.event ? event.event : event.raw, event.returnValues);

            await waitForBlockNumber(web3, event.blockNumber);
            
            let organization;
            let subOrganization;

            switch (event.event) {
                case "OrganizationCreated":
                case "OrganizationOwnershipTransferred":
                case "OrgJsonUriChanged":
                case "OrgJsonHashChanged":
                case "LifDepositAdded": 
                case "WithdrawalRequested":
                case "DepositWithdrawn":
                    organization = await parseOrganization(
                        web3,
                        orgidContract,
                        event.returnValues.orgId,
                        orgIdResolver
                    );
                    await cached.upsertOrgid(organization);

                    log.info('Parsed organization:', JSON.stringify(organization));
                    break;
                
                // Event fired when a subsidary is created
                case "SubsidiaryCreated":
                    parentOrganization = await parseOrganization(
                        web3,
                        orgidContract,
                        event.returnValues.parentOrgId,
                        orgIdResolver
                    );
                    subOrganization = await parseOrganization(
                        web3,
                        orgidContract,
                        event.returnValues.subOrgId,
                        orgIdResolver
                    );
                    await cached.upsertOrgid(parentOrganization);
                    await cached.upsertOrgid(subOrganization);
                    
                    log.info(JSON.stringify(parentOrganization));
                    log.info(JSON.stringify(subOrganization));
                    break;
                
                case "WithdrawDelayChanged":
                    break;

                default:
                    log.debug(`this event do not have any reaction behavior`);
            }

            // Saving a block number where the event has been successfully parsed
            await cached.saveBlockNumber(String(currentBlockNumber));
        } catch (error) {
            log.error('Error during resolve event', error);
        }
    };

    // Get the subsidaries of an orgid
    const getSubsidiaries = (orgidContract, orgid) => {
        return orgidContract.methods
            .getSubsidiaries(orgid)
            .call();
    };

    // Parse an organization
    const parseOrganization = async (web3, orgidContract, orgid, orgIdResolver) => {
        log.debug('[.]', chalk.blue('parseOrganization'), orgid, typeof orgid);

        const resolverResult = await orgIdResolver.resolve(`did:orgid:${orgid}`);

        // Show resolver errors
        if (resolverResult.errors && resolverResult.errors.length > 0) {
            resolverResult.errors.forEach(error => {
                log.warn(error.title, JSON.stringify(error));
            });
        }
        
        let jsonContent;

        if (resolverResult.didDocument && resolverResult.organization) {
            jsonContent = resolverResult.didDocument;
        } else {
            throw new Error(
                `Unable to resolve a DID document for the orgId: ${orgid}`
            );
        }

        log.debug(`Organization Details: ${JSON.stringify(resolverResult.organization)}`);
        log.debug(`Organization DID document: ${JSON.stringify(resolverResult.didDocument)}`);

        const {
            owner,
            director,
            state,
            directorConfirmed,
            parentEntity,
            deposit
        } = resolverResult.organization;

        // Retrieve the parent organization (if exists)
        let parent;

        if (parentEntity !== orgid0x) {
            try {
                parent = await parseOrganization(
                    web3,
                    orgidContract,
                    parentEntity,
                    orgIdResolver
                );
            } catch (error) {
                log.error('Unable to resolve parent organization', error);
            }
        }

        // Retrieve OrgID Type
        let orgidType = 'unknown';

        if (jsonContent.legalEntity) {
            orgidType = 'legalEntity';
        } else if (jsonContent.organizationalUnit) {
            orgidType = 'organizationalUnit';
        }

        // Retrieve Directory
        let directory = 'unknown';

        if (orgidType == 'legalEntity') {
            directory = 'legalEntity';
        } else if (orgidType == 'organizationalUnit') {
            directory = jsonContent.organizationalUnit.type;
            // Directory should be an array
            // But Database expects a string
            if (Array.isArray(directory)) {
                // Backward compatibility for Arbor BE
                if (directory.length === 1) {
                    directory = directory[0];
                } else {
                    directory = JSON.stringify(directory);
                }
            }
        }

        // Retrieve name
        let name = 'Name is not defined';

        if (orgidType == 'legalEntity') {
            name = jsonContent.legalEntity.legalName;
        } else if (orgidType == 'organizationalUnit') {
            name = jsonContent.organizationalUnit.name;
        }

        // Retrieve country
        let country;

        if (orgidType == 'legalEntity' && jsonContent.legalEntity.registeredAddress) {
            country = jsonContent.legalEntity.registeredAddress.country;

        } else if (orgidType == 'organizationalUnit' && jsonContent.organizationalUnit.address) {
            country = jsonContent.organizationalUnit.address.country;
        }

        if (country && country.length !== 2) {
            country = '';
        }

        // Retrieve logo
        let logo;

        if (jsonContent.media) {
            logo = jsonContent.media.logo;
        }

        // Retrieve contacts
        let contact = _.get(jsonContent, `${orgidType}.contacts[0]`, {});

        // Check the LIF deposit amount
        let lifDeposit = web3.utils.fromWei(deposit, 'ether');
        let isLifProved = lifDeposit >= environment.lifMinimumDeposit;

        // Facebook Trust clue
        const isSocialFBProved = getTrustAssertsion(resolverResult, 'social', 'facebook');

        // Twitter Trust clue
        const isSocialTWProved = getTrustAssertsion(resolverResult, 'social', 'twitter');

        // Instagram Trust clue
        const isSocialIGProved = getTrustAssertsion(resolverResult, 'social', 'instagram');

        // Linkedin Trust clue
        const isSocialLNProved = getTrustAssertsion(resolverResult, 'social', 'linkedin');

        // Web-site Trust clue
        // @todo Website assertion should be obtained from the trust assertion record
        const isWebsiteProved = getTrustAssertsion(resolverResult, 'domain', contact.website);

        // SSL Trust clue
        const isSslProved = isWebsiteProved ? checkSslByUrl(website) : false;

        // Overall Social Trust proof
        const isSocialProved = isSocialFBProved || isSocialTWProved || isSocialIGProved || isSocialLNProved;
        
        // Counting total count of proofs
        const proofsQty = _.compact([isWebsiteProved, isSslProved, isLifProved, isSocialProved]).length;

        // Retrieve the subsidiaries (if exists)
        let subsidiaries = await getSubsidiaries(orgidContract, orgid);

        // Retrurn all the organization details
        return {
            orgid,
            owner,
            subsidiaries,
            parent,
            orgidType,
            directory,
            director,
            state,
            directorConfirmed,
            name,
            logo,
            country,
            proofsQty,
            isLifProved,
            isWebsiteProved,
            isSslProved,
            isSocialFBProved,
            isSocialTWProved,
            isSocialIGProved,
            jsonContent,
            jsonCheckedAt: new Date().toJSON(),
            jsonUpdatedAt: new Date().toJSON()
        };
    };

    // Retrieve ALL organizations
    const getOrganizationsList = () => {
        return orgidContract.methods.getOrganizations().call();
    };

    const scrapeOrganizations = async () => {
        const organizations = await getOrganizationsList();

        log.info('Scrape organizations:', organizations);

        for (const orgid of organizations) {

            let organization = {};
            try {
                organization = await parseOrganization(
                    web3,
                    orgidContract,
                    orgid,
                    orgIdResolver
                );
                
                log.debug(organization);

                await cached.upsertOrgid(organization);
            } catch (e) {
                log.warn('Error during parseOrganization / upsertOrgid', e.toString());
            }

            if (organization.subsidiaries) {
                log.info('PARSE SUBSIDIARIES:', JSON.stringify(organization.subsidiaries));
                
                for (let orgid of organization.subsidiaries) {
                    try {
                        let subOrganization = await parseOrganization(
                            web3,
                            orgidContract,
                            orgid,
                            orgIdResolver
                        );
                        await cached.upsertOrgid(subOrganization);
                    } catch (e) {
                        log.warn('Error during [SubOrg] parseOrganization / upsertOrgid', e.toString());
                    }
                }
            }
        }
    };

    return Promise.resolve({
        scrapeOrganizations,
        listenEvents
    });
};
