import * as express from 'express';

import { AtomicAssetsNamespace } from '../index';
import { WebServer } from '../../../server';
import logger from '../../../../utils/winston';
import { filterQueryArgs } from '../../utils';
import { formatOffer } from '../format';

export function offersEndpoints(core: AtomicAssetsNamespace, web: WebServer, router: express.Router): void {
    router.get('/v1/offers', (async (req, res) => {
        try {
            const args = filterQueryArgs(req, {
                page: {type: 'int', min: 1, default: 1},
                limit: {type: 'int', min: 1, max: 100, default: 100},
                sort: {type: 'string', values: ['created'], default: 'created'},
                order: {type: 'string', values: ['asc', 'desc'], default: 'desc'},

                account: {type: 'string', min: 1, max: 12},
                sender: {type: 'string', min: 1, max: 12},
                recipient: {type: 'string', min: 1, max: 12}
            });

            let varCounter = 1;
            let queryString = 'SELECT * FROM atomicassets_offers_master WHERE contract = $1 ';

            const queryValues: any[] = [core.args.contract];

            if (args.account) {
                queryString += 'AND (sender_name = $' + ++varCounter + ' OR recipient_name = $' + varCounter + ') ';
                queryValues.push(args.account);
            }

            if (args.sender) {
                queryString += 'AND sender_name = $' + ++varCounter + ' ';
                queryValues.push(args.sender);
            }

            if (args.recipient) {
                queryString += 'AND recipient_name = $' + ++varCounter + ' ';
                queryValues.push(args.recipient);
            }

            const sortColumnMapping = {
                created: 'created_at_block'
            };

            // @ts-ignore
            queryString += 'ORDER BY ' + sortColumnMapping[args.sort] + ' ' + args.order + ' ';
            queryString += 'LIMIT $' + ++varCounter + ' OFFSET $' + ++varCounter + ' ';
            queryValues.push(args.limit);
            queryValues.push((args.page - 1) * args.limit);

            logger.debug(queryString);

            const query = await core.connection.database.query(queryString, queryValues);

            return res.json({success: true, data: query.rows.map((row) => formatOffer(row))});
        } catch (e) {
            logger.error(e);

            res.status(500);
            res.json({success: false, message: 'Internal Server Error'});
        }
    }));

    router.get('/v1/offers/:offer_id', (async (req, res) => {
        try {
            const query = await core.connection.database.query(
                'SELECT * FROM atomicassets_offers_master WHERE contract = $1 AND offer_id = $2',
                [core.args.contract, req.params.offer_id]
            );

            if (query.rowCount === 0) {
                res.status(500);

                return res.json({success: false, message: 'Offer not found'});
            }

            return res.json({success: true, data: formatOffer(query.rows[0])});
        } catch (e) {
            logger.error(e);

            res.status(500);
            return res.json({success: false, message: 'Internal Server Error'});
        }
    }));
}
