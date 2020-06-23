const Joi = require('@hapi/joi');
const express = require('express');
const router = express.Router();
const filenameSplitted = __filename.split(__filename[0]);
const log = require("log4js").getLogger('rest');
log.level = 'debug';

module.exports = function (rest, controller) {

    router.get('/stats/connection', async (req, res) => {
        try {
            const json = {
                connected: controller.isConnected(),
                reconnection: controller.isReconnection()
            };
            res.status(200).send(json); 
        } catch (e) {
            const {code, json} = rest.decorateError(e);
            res.status(code).send(json);
        }
    });
    
    router.post('/orgids/:address/refresh', async (req, res) => {
        const { address } = req.params;

        try {
            await controller.refreshOrganization(address);
            const orgId = await controller.cached.getOrgId(address);
            const self = req.protocol + '://' + req.get('host') + req.originalUrl;
            const json = {
                links: {
                    self,
                },
                data: {
                    type: 'orgid',
                    ...orgId
                }
            };
            res.status(200).send(json);            
        } catch (e) {
            const {code, json} = rest.decorateError(e);
            res.status(code).send(json);
        }
    });

    rest.addRouter(['/api/v1/', router]);

    return Promise.resolve({})
};