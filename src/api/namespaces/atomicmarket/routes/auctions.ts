import * as express from 'express';

import { AtomicMarketNamespace } from '../index';
import { HTTPServer } from '../../../server';
import { formatAuction } from '../format';
import { fillAuctions } from '../filler';
import { buildAuctionFilter } from '../utils';
import { getOpenAPI3Responses, paginationParameters } from '../../../docs';
import { assetFilterParameters } from '../../atomicassets/openapi';
import logger from '../../../../utils/winston';
import { filterQueryArgs } from '../../utils';
import { atomicDataFilter, listingFilterParameters } from '../openapi';

export function auctionsEndpoints(core: AtomicMarketNamespace, server: HTTPServer, router: express.Router): any {
    router.get('/v1/auctions', server.web.caching(), async (req, res) => {
        try {
            const args = filterQueryArgs(req, {
                page: {type: 'int', min: 1, default: 1},
                limit: {type: 'int', min: 1, max: 100, default: 100},
                sort: {type: 'string', values: ['created', 'ending', 'auction_id', 'price'], default: 'created'},
                order: {type: 'string', values: ['asc', 'desc'], default: 'desc'}
            });

            const filter = buildAuctionFilter(req, 1);

            let queryString = 'SELECT * FROM atomicmarket_auctions_master listing WHERE market_contract = $1 ' + filter.str;
            const queryValues = [core.args.atomicmarket_account, ...filter.values];
            let varCounter = queryValues.length;

            const sortColumnMapping = {
                auction_id: 'auction_id',
                ending: 'end_time',
                created: 'created_at_block',
                price: 'raw_price'
            };

            // @ts-ignore
            queryString += 'ORDER BY ' + sortColumnMapping[args.sort] + ' ' + args.order + ' ';
            queryString += 'LIMIT $' + ++varCounter + ' OFFSET $' + ++varCounter + ' ';
            queryValues.push(args.limit);
            queryValues.push((args.page - 1) * args.limit);

            logger.debug(queryString);

            const query = await core.connection.database.query(queryString, queryValues);

            const auctions = await fillAuctions(
                core.connection, core.args.atomicassets_account, query.rows.map((row) => formatAuction(row))
            );

            res.json({success: true, data: auctions});
        } catch (e) {
            logger.error(e);

            res.status(500).json({success: false, message: 'Internal Server Error'});
        }
    });

    router.get('/v1/auctions/:auction_id', server.web.caching(), async (req, res) => {
        try {
            const query = await core.connection.database.query(
                'SELECT * FROM atomicmarket_auctions_master WHERE market_contract = $1 AND auction_id = $2',
                [core.args.atomicmarket_account, req.params.auction_id]
            );

            if (query.rowCount === 0) {
                res.status(500).json({success: false, message: 'Auction not found'});
            } else {
                const auctions = await fillAuctions(
                    core.connection, core.args.atomicassets_account, query.rows.map((row) => formatAuction(row))
                );

                res.json({success: true, data: auctions[0]});
            }
        } catch (e) {
            logger.error(e);

            res.status(500).json({success: false, message: 'Internal Server Error'});
        }

    });

    return {
        tag: {
            name: 'auctions',
            description: 'Auctions'
        },
        paths: {
            '/v1/auctions': {
                get: {
                    tags: ['auctions'],
                    summary: 'Get all auctions.' + atomicDataFilter,
                    parameters: [
                        {
                            name: 'state',
                            in: 'query',
                            description: 'Filter by auction state (' +
                                '0: WAITING: Auction created but assets were not transferred yet, ' +
                                '1: LISTED - Auction pending and open to bids, ' +
                                '2: CANCELED - Auction was canceled, ' +
                                '3: SOLD - Auction has been sold, ' +
                                '4: INVALID - Auction ended but no bid was made' +
                                ') - separate multiple with ","',
                            required: false,
                            schema: {type: 'string'}
                        },
                        ...listingFilterParameters,
                        ...assetFilterParameters,
                        ...paginationParameters,
                        {
                            name: 'sort',
                            in: 'query',
                            description: 'Column to sort',
                            required: false,
                            schema: {
                                type: 'string',
                                enum: ['created', 'ending', 'auction_id', 'price'],
                                default: 'created'
                            }
                        }
                    ],
                    responses: getOpenAPI3Responses([200], {
                        type: 'array',
                        items: {'$ref': '#/components/schemas/Auction'}
                    })
                }
            },
            '/v1/auctions/{auction_id}': {
                get: {
                    tags: ['auctions'],
                    summary: 'Get a specific auction by id',
                    parameters: [
                        {
                            in: 'path',
                            name: 'auction_id',
                            description: 'Auction Id',
                            required: true,
                            schema: {type: 'integer'}
                        }
                    ],
                    responses: getOpenAPI3Responses([200, 500], {'$ref': '#/components/schemas/Auction'})
                }
            }
        }
    };
}
