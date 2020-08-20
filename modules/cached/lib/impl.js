const _ = require('lodash');
const chalk = require('chalk');
const Sequelize = require('sequelize');
const Op = Sequelize.Op;
const log = require('log4js').getLogger('cached');
log.level = 'debug';

module.exports = function (config, models) {
    const { currentEnvironment, environments } = config();
    const environment = environments[process.env.NODE_ENV === 'development' ? 'development' : currentEnvironment];

    const upsertOrgid = async (organizationPayload) => {
        log.debug('[.]', chalk.blue('upsertOrgid') , JSON.stringify(organizationPayload));
        let orgid;
        try {
            orgid = await models.orgid.upsert(organizationPayload, { orgid: organizationPayload.orgid });
            log.debug('view created org');
        } catch (e) {
            log.warn('upsertOrgid error during orgid upsert:', e.toString());
            log.debug('upsertOrgid error during orgid upsert:', e);
            throw e.toString()
        }

        return orgid;
    };

    const updateOrgidData = async (orgid, data) => {
        return await models.orgid.update(data, {
            where: {
                orgid
            }
        });
    };

    const getOrgId = async (address) => {
        let orgid = await models.orgid.findOne({where: {orgid: address}});
        if (orgid) {
            orgid = orgid.get();
            orgid.type = 'orgid';
            orgid.orgJsonContent = orgid.orgJsonContent && orgid.orgJsonContent.toString ? orgid.orgJsonContent.toString() : orgid.orgJsonContent;
        }

        return orgid
    };

    const getOrgIdRaw = async (address) => {
        return models.orgid.findOne({where: {orgid: address}});
    };

    const getOrgIds = async (query) => {
        const { page, sort, ...where } = query;
        let order = [];
        if (sort) {
            order = sort.split(',').map((sortCriteria) => {
                let sortDirection = 'ASC';
                if(sortCriteria[0] === '-') {
                    sortDirection = 'DESC';
                    sortCriteria = sortCriteria.substr(1)
                }
                return [sortCriteria, sortDirection];
            })
        }
        if (where['parent.orgid']) {
            where.parent = {
                [Op.like]: `%${where['parent.orgid']}%`
            };
            delete where['parent.orgid'];
        }
        if (where.name) {
            if (where.name.length === 42 && where.name[0] === '0' && where.name[1] === 'x') {
                where[Op.or] = {
                    orgid: where.name,
                    parent: {
                        [Op.like]: `%${where.name}%`
                    },
                    owner: where.name
                };
                delete where.name;
            } else {
                where.name = {
                    [Op.like]: `%${where.name}%`
                }
            }
        }
        const limit = _.get(page, 'size', 25);
        const offset = (_.get(page, 'number', 1)-1) * limit;

        let { rows:orgids, count } = await models.orgid.findAndCountAll({ attributes: ['orgid', 'state', 'subsidiaries', 'parent', 'orgidType', 'directory', 'name', 'logo', 'proofsQty', 'owner', 'country'], where, order, offset, limit });
        orgids = _.map(orgids, orgid => {
            orgid = orgid.get();
            orgid.type = 'orgid';
            // orgid.jsonContent = orgid.jsonContent && orgid.jsonContent.toString ? orgid.jsonContent.toString() : orgid.jsonContent;
            return orgid;
        });
        return { rows: orgids, count }
    };

    const saveBlockNumber = (value = 0) => models.stats.upsert({
        name: 'blockNumber',
        value
    });

    const getBlockNumber = async () => {
        const record = await models.stats.findOne({
            where: {
                name: {
                    [Op.eq]: 'blockNumber'
                }
            }
        });
        const value = record && record.value ? Number(record.value) : 0;
        return String(value) !== 'NaN' ? value : 0;
    }

    // ??????? model `section` not defined
    const getSegments = async () => {
        let segments = await models.section.findAll();
        segments = _.map(segments, segment => {
            segment = segment.get();
            segment.type = 'segment';
            return segment;
        });

        return segments
    };

    const saveProfileDraft = async (json) => {
        const draft = await models.drafts.create({ json });
        return {
            profileId: draft.profileId,
            password: draft.password
        };
    };

    const updateProfileDraft = async (profileId, password, json) => {
        const draft = await models.drafts.findOne({ where: { profileId, password } });
        if (!draft) {
            const err = new Error('Profile not found');
            err.code = 404;
            throw  err;
        }
        return await draft.update({ json });
    };

    const removeProfileDraft = async (profileId, password) => {
        await models.drafts.destroy({ where: { profileId, password } });
    };

    const getProfileDraft = async profileId => {
        const draft = await models.drafts.findOne({ where: { profileId } });
        if (!draft) {
            const err = new Error('Profile not found');
            err.code = 404;
            throw  err;
        }
        return draft.json
    };

    return Promise.resolve({
        upsertOrgid,
        updateOrgidData,
        getOrgId,
        getOrgIdRaw,
        getOrgIds,
        getSegments,
        saveBlockNumber,
        getBlockNumber,
        saveProfileDraft,
        updateProfileDraft,
        removeProfileDraft,
        getProfileDraft,
        environment: () => environment
    });
};
