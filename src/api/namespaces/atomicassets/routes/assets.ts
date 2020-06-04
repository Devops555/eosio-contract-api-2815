import * as express from 'express';

import { AtomicAssetsNamespace } from '../index';
import { HTTPServer } from '../../../server';
import { buildDataConditions, getLogs } from '../utils';
import { filterQueryArgs } from '../../utils';
import logger from '../../../../utils/winston';
import { formatAsset } from '../format';
import { paginationFilter, standardArrayFilter } from '../swagger';

export function assetsEndpoints(core: AtomicAssetsNamespace, server: HTTPServer, router: express.Router): any {
    router.get('/v1/assets', server.web.caching({ contentType: 'text/json' }), (async (req, res) => {
        try {
            const args = filterQueryArgs(req, {
                page: {type: 'int', min: 1, default: 1},
                limit: {type: 'int', min: 1, max: 1000, default: 100},
                sort: {type: 'string', values: ['asset_id', 'updated', 'minted'], default: 'asset_id'},
                order: {type: 'string', values: ['asc', 'desc'], default: 'desc'},

                owner: {type: 'string', min: 1, max: 12},
                template_id: {type: 'int', min: 0},
                collection_name: {type: 'string', min: 1, max: 12},
                schema_name: {type: 'string', min: 1, max: 12},

                authorized_account: {type: 'string', min: 1, max: 12},
                match: {type: 'string', min: 1}
            });

            let varCounter = 1;
            let queryString = 'SELECT * FROM atomicassets_assets_master asset WHERE contract = $1 ';
            let queryValues: any[] = [core.args.atomicassets_account];

            if (args.collection_name && args.schema_name) {
                const data = buildDataConditions(req.query, varCounter);

                if (data.conditions.length > 0) {
                    queryString += 'AND (' +
                        'EXISTS (' +
                            'SELECT "key" ' +
                            'FROM atomicassets_assets_data data ' +
                            'WHERE data.contract = asset.contract AND data.asset_id = asset.asset_id AND ' +
                            '(' + data.conditions.join(' OR ') + ')' +
                        ') ';

                    queryString += 'OR ' +
                        'EXISTS (' +
                            'SELECT "key" ' +
                            'FROM atomicassets_templates_data data ' +
                            'WHERE data.contract = asset.contract AND data.template_id = asset.template_id AND ' +
                            '(' + data.conditions.join(' OR ') + ')' +
                        ')) ';

                    queryValues = queryValues.concat(data.values);
                    varCounter += data.values.length;
                }
            }

            if (args.owner) {
                queryString += 'AND owner = $' + ++varCounter + ' ';
                queryValues.push(args.owner);
            }

            if (args.template_id) {
                queryString += 'AND template_id = $' + ++varCounter + ' ';
                queryValues.push(args.template_id);
            }

            if (args.collection_name) {
                queryString += 'AND collection_name = $' + ++varCounter + ' ';
                queryValues.push(args.collection_name);
            }

            if (args.schema_name) {
                queryString += 'AND schema_name = $' + ++varCounter + ' ';
                queryValues.push(args.schema_name);
            }

            if (args.match) {
                queryString += 'AND name LIKE $' + ++varCounter + ' ';
                queryValues.push('%' + args.match + '%');
            }

            if (args.authorized_account) {
                queryString += 'AND $' + ++varCounter + ' = ANY(authorized_accounts) ';
                queryValues.push(args.authorized_account);
            }

            const sortColumnMapping = {
                asset_id: 'asset_id',
                updated: 'updated_at_block',
                minted: 'minted_at_block'
            };

            // @ts-ignore
            queryString += 'ORDER BY ' + sortColumnMapping[args.sort] + ' ' + args.order + ' ';
            queryString += 'LIMIT $' + ++varCounter + ' OFFSET $' + ++varCounter + ' ';
            queryValues.push(args.limit);
            queryValues.push((args.page - 1) * args.limit);

            logger.debug(queryString);

            const query = await core.connection.database.query(queryString, queryValues);

            return res.json({success: true, data: query.rows.map((row) => formatAsset(row)), query_time: Date.now()});
        } catch (e) {
            logger.error(e);

            res.status(500);
            return res.json({success: false, message: 'Internal Server Error'});
        }
    }));

    router.get('/v1/assets/:asset_id', server.web.caching({ contentType: 'text/json' }), (async (req, res) => {
        try {
            const query = await core.connection.database.query(
                'SELECT * FROM atomicassets_assets_master WHERE contract = $1 AND asset_id = $2',
                [core.args.atomicassets_account, req.params.asset_id]
            );

            if (query.rowCount === 0) {
                res.status(500);

                return res.json({success: false, message: 'Asset not found'});
            }

            return res.json({success: true, data: formatAsset(query.rows[0]), query_time: Date.now()});
        } catch (e) {
            logger.error(e);

            res.status(500);
            return res.json({success: false, message: 'Internal Server Error'});
        }
    }));

    router.get('/v1/assets/:asset_id/logs', server.web.caching({ contentType: 'text/json' }), (async (req, res) => {
        const args = filterQueryArgs(req, {
            page: {type: 'int', min: 1, default: 1},
            limit: {type: 'int', min: 1, max: 100, default: 100}
        });

        try {
            res.json({
                success: true,
                data: await getLogs(
                    core.connection.database, core.args.atomicassets_account, 'asset', req.params.asset_id,
                    (args.page - 1) * args.limit, args.limit
                ), query_time: Date.now()
            });
        } catch (e) {
            logger.error(e);

            res.status(500);
            return res.json({success: false, message: 'Internal Server Error'});
        }
    }));

    return {
        tag: {
            name: 'assets',
            description: 'Assets'
        },
        paths: {
            '/v1/assets': {
                get: {
                    tags: ['assets'],
                    summary: 'Fetch assets',
                    produces: ['application/json'],
                    parameters: [
                        {
                            name: 'owner',
                            in: 'query',
                            description: 'Get assets owned by the account',
                            required: false,
                            type: 'string'
                        },
                        {
                            name: 'collection_name',
                            in: 'query',
                            description: 'Get all assets within the collection',
                            required: false,
                            type: 'string'
                        },
                        {
                            name: 'schema_name',
                            in: 'query',
                            description: 'Get all assets which use that schema',
                            required: false,
                            type: 'string'
                        },
                        {
                            name: 'template_id',
                            in: 'query',
                            description: 'Get all assets implement the template',
                            required: false,
                            type: 'integer'
                        },
                        {
                            name: 'match',
                            in: 'query',
                            description: 'Search for input in asset name',
                            required: false,
                            type: 'string'
                        },
                        {
                            name: 'authorized_account',
                            in: 'query',
                            description: 'Filter for assets the provided account can edit',
                            required: false,
                            type: 'string'
                        },
                        ...standardArrayFilter,
                        {
                            name: 'sort',
                            in: 'query',
                            description: 'Column to sort',
                            required: false,
                            type: 'string',
                            enum: ['asset_id', 'minted', 'updated'],
                            default: 'asset_id'
                        }
                    ],
                    responses: {
                        '200': {
                            description: 'OK',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: true},
                                    data: {type: 'array', items: {'$ref': '#/definitions/Asset'}},
                                    query_time: {type: 'number'}
                                }
                            }
                        },
                        '500': {
                            description: 'Internal Server Error',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: false},
                                    message: {type: 'string'}
                                }
                            }
                        }
                    }
                }
            },
            '/v1/assets/{asset_id}': {
                get: {
                    tags: ['assets'],
                    summary: 'Fetch asset by id',
                    produces: ['application/json'],
                    parameters: [
                        {
                            name: 'asset_id',
                            in: 'path',
                            description: 'ID of asset',
                            required: true,
                            type: 'string'
                        }
                    ],
                    responses: {
                        '200': {
                            description: 'OK',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: true},
                                    data: {'$ref': '#/definitions/Asset'},
                                    query_time: {type: 'number'}
                                }
                            }
                        },
                        '500': {
                            description: 'Internal Server Error',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: false},
                                    message: {type: 'string'}
                                }
                            }
                        }
                    }
                }
            },
            '/v1/assets/{asset_id}/logs': {
                get: {
                    tags: ['assets'],
                    summary: 'Fetch asset logs',
                    produces: ['application/json'],
                    parameters: [
                        {
                            name: 'asset_id',
                            in: 'path',
                            description: 'ID of asset',
                            required: true,
                            type: 'integer'
                        },
                        ...paginationFilter
                    ],
                    responses: {
                        '200': {
                            description: 'OK',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: true},
                                    data: {'$ref': '#/definitions/Log'},
                                    query_time: {type: 'number'}
                                }
                            }
                        },
                        '500': {
                            description: 'Internal Server Error',
                            schema: {
                                type: 'object',
                                properties: {
                                    success: {type: 'boolean', default: false},
                                    message: {type: 'string'}
                                }
                            }
                        }
                    }
                }
            }
        },
        definitions: {}
    };
}

export type SocketAssetSubscriptionArgs = {
    asset_ids: string[],
    owners: string[],
    new_assets: boolean,
    updates: boolean
};

export function assetsSockets(core: AtomicAssetsNamespace, server: HTTPServer): void {
    const namespace = server.socket.io.of(core.path + '/v1/assets');

    namespace.on('connection', async (socket) => {
        logger.debug('socket asset client connected');

        let verifiedConnection = false;
        if (!(await server.socket.reserveConnection(socket))) {
            socket.disconnect(true);
        } else {
            verifiedConnection = true;
        }

        socket.on('subscribe', (options: SocketAssetSubscriptionArgs) => {
            if (typeof options !== 'object') {
                return;
            }

            logger.debug('asset socket subscription', options);

            socket.leaveAll();

            const subscribeLimit = server.config.socket_limit.subscriptions_per_connection;
            let subscribeCounter = 0;

            if (Array.isArray(options.asset_ids)) {
                for (const assetId of options.asset_ids) {
                    if (typeof assetId === 'string') {
                        if (subscribeCounter > subscribeLimit) {
                            socket.emit('subscribe_limit', {max_subscriptions: subscribeLimit});

                            return;
                        }

                        socket.join('assets:asset_id:' + assetId);
                        subscribeCounter++;
                    }
                }
            }

            if (Array.isArray(options.owners)) {
                for (const owner of options.owners) {
                    if (typeof owner === 'string') {
                        if (subscribeCounter > subscribeLimit) {
                            socket.emit('subscribe_limit', {max_subscriptions: subscribeLimit});

                            return;
                        }

                        socket.join('assets:owner:' + owner);
                        subscribeCounter++;
                    }
                }
            }

            if (options.new_assets) {
                if (subscribeCounter > subscribeLimit) {
                    socket.emit('subscribe_limit', {max_subscriptions: subscribeLimit});

                    return;
                }

                socket.join('assets:new_assets');
                subscribeCounter++;
            }

            if (options.updates) {
                if (subscribeCounter > subscribeLimit) {
                    socket.emit('subscribe_limit', {max_subscriptions: subscribeLimit});

                    return;
                }

                socket.join('assets:updates');
                subscribeCounter++;
            }

            logger.debug('socket rooms updated', socket.adapter.rooms);
        });

        socket.on('disconnect', async () => {
            if (verifiedConnection) {
                await server.socket.releaseConnection(socket);
            }
        });
    });

    const assetChannelName = [
        'eosio-contract-api', core.connection.chain.name, 'atomicassets',
        core.args.atomicassets_account, 'assets'
    ].join(':');
    core.connection.redis.ioRedisSub.subscribe(assetChannelName, () => {
        core.connection.redis.ioRedisSub.on('message', async (channel, message) => {
            if (channel !== assetChannelName) {
                return;
            }

            const msg = JSON.parse(message);

            const query = await core.connection.database.query(
                'SELECT * FROM atomicassets_assets_master WHERE contract = $1 AND asset_id = $2',
                [core.args.atomicassets_account, msg.data.asset_id]
            );

            if (query.rowCount === 0) {
                logger.error('Received asset notification but did not find it in database');

                return;
            }

            const asset = query.rows[0];

            const rooms = [
                'assets:owner:' + asset.owner, 'assets:asset_id:' + asset.asset_id
            ];

            if (msg.action === 'mint') {
                rooms.push('assets:new_assets');

                rooms.reduce((previousValue, currentValue) => previousValue.to(currentValue), namespace)
                    .emit('new_asset', {
                        transaction: msg.transaction,
                        block: msg.block,
                        asset: formatAsset(asset)
                    });
            } else if (msg.action === 'burn') {
                rooms.push('assets:updates');

                rooms.reduce((previousValue, currentValue) => previousValue.to(currentValue), namespace)
                    .emit('burn', {
                        transaction: msg.transaction,
                        block: msg.block,
                        asset: formatAsset(asset)
                    });
            } else if (msg.action === 'back') {
                rooms.push('assets:updates');

                rooms.reduce((previousValue, currentValue) => previousValue.to(currentValue), namespace)
                    .emit('back', {
                        transaction: msg.transaction,
                        block: msg.block,
                        asset: formatAsset(asset),
                        trace: msg.data.trace
                    });
            } else if (msg.action === 'update') {
                rooms.push('assets:updates');

                rooms.reduce((previousValue, currentValue) => previousValue.to(currentValue), namespace)
                    .emit('update', {
                        transaction: msg.transaction,
                        block: msg.block,
                        asset: formatAsset(asset),
                        delta: msg.data.delta
                    });
            }
        });
    });

    const chainChannelName = ['eosio-contract-api', core.connection.chain.name, 'chain'].join(':');
    core.connection.redis.ioRedisSub.subscribe(chainChannelName, () => {
        core.connection.redis.ioRedisSub.on('message', async (channel, message) => {
            if (channel !== chainChannelName) {
                return;
            }

            const msg = JSON.parse(message);

            if (msg.action === 'fork') {
                namespace.emit('fork', {block_num: msg.block_num});
            }
        });
    });
}
