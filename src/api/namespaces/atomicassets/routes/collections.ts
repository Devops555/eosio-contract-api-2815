import * as express from 'express';

import { AtomicAssetsNamespace } from '../index';
import { HTTPServer } from '../../../server';
import { buildBoundaryFilter, filterQueryArgs } from '../../utils';
import { buildGreylistFilter, getLogs } from '../utils';
import logger from '../../../../utils/winston';
import { formatCollection } from '../format';
import { dateBoundaryParameters, getOpenAPI3Responses, paginationParameters, primaryBoundaryParameters } from '../../../docs';
import { greylistFilterParameters } from '../openapi';

export function collectionsEndpoints(core: AtomicAssetsNamespace, server: HTTPServer, router: express.Router): any {
    router.get(['/v1/collections', '/v1/collections/_count'], server.web.caching(), (async (req, res) => {
        try {
            const args = filterQueryArgs(req, {
                page: {type: 'int', min: 1, default: 1},
                limit: {type: 'int', min: 1, max: 100, default: 100},
                sort: {type: 'string', values: ['created', 'collection_name'], default: 'created'},
                order: {type: 'string', values: ['asc', 'desc'], default: 'desc'},

                author: {type: 'string', min: 1, max: 12},
                authorized_account: {type: 'string', min: 1, max: 12},
                notify_account: {type: 'string', min: 1, max: 12},

                match: {type: 'string', min: 1}
            });

            let varCounter = 1;
            let queryString = 'SELECT * FROM atomicassets_collections_master WHERE contract = $1 ';

            const queryValues: any[] = [core.args.atomicassets_account];

            if (args.author) {
                queryString += 'AND author = $' + ++varCounter + ' ';
                queryValues.push(args.author);
            }

            if (args.authorized_account) {
                queryString += 'AND $' + ++varCounter + ' = ANY(authorized_accounts) ';
                queryValues.push(args.authorized_account);
            }

            if (args.notify_account) {
                queryString += 'AND $' + ++varCounter + ' = ANY(notify_accounts) ';
                queryValues.push(args.notify_account);
            }

            if (args.match) {
                queryString += 'AND collection_name ILIKE $' + ++varCounter + ' ';
                queryValues.push('%' + args.match + '%');
            }

            const boundaryFilter = buildBoundaryFilter(
                req, varCounter, 'collection_name', 'string',
                'created_at_time', 'created_at_block'
            );
            queryValues.push(...boundaryFilter.values);
            varCounter += boundaryFilter.values.length;
            queryString += boundaryFilter.str;

            const blacklistFilter = buildGreylistFilter(req, varCounter, 'collection_name');
            queryValues.push(...blacklistFilter.values);
            varCounter += blacklistFilter.values.length;
            queryString += blacklistFilter.str;

            if (req.originalUrl.search('/_count') >= 0) {
                const countQuery = await server.query(
                    'SELECT COUNT(*) counter FROM (' + queryString + ') x',
                    queryValues
                );

                return res.json({success: true, data: countQuery.rows[0].counter, query_time: Date.now()});
            }

            const sortColumnMapping = {
                created: 'created_at_block',
                collection_name: 'collection_name'
            };

            // @ts-ignore
            queryString += 'ORDER BY ' + sortColumnMapping[args.sort] + ' ' + args.order + ', collection_name ASC ';
            queryString += 'LIMIT $' + ++varCounter + ' OFFSET $' + ++varCounter + ' ';
            queryValues.push(args.limit);
            queryValues.push((args.page - 1) * args.limit);

            const query = await server.query(queryString, queryValues);

            return res.json({success: true, data: query.rows.map((row) => formatCollection(row)), query_time: Date.now()});
        } catch (e) {
            res.status(500).json({success: false, message: 'Internal Server Error'});
        }
    }));

    router.get('/v1/collections/:collection_name', server.web.caching({ignoreQueryString: true}), (async (req, res) => {
        try {
            const query = await server.query(
                'SELECT * FROM atomicassets_collections_master WHERE contract = $1 AND collection_name = $2',
                [core.args.atomicassets_account, req.params.collection_name]
            );

            if (query.rowCount === 0) {
                return res.status(416).json({success: false, message: 'Collection not found'});
            }

            return res.json({success: true, data: formatCollection(query.rows[0]), query_time: Date.now()});
        } catch (e) {
            return res.status(500).json({success: false, message: 'Internal Server Error'});
        }
    }));

    router.get('/v1/collections/:collection_name/stats', server.web.caching({ignoreQueryString: true}), (async (req, res) => {
        try {
            const query = await server.query(
                'SELECT ' +
                '(SELECT COUNT(*) FROM atomicassets_assets WHERE contract = $1 AND collection_name = $2) assets, ' +
                '(SELECT COUNT(*) FROM atomicassets_assets WHERE contract = $1 AND collection_name = $2 AND owner IS NULL) burned, ' +
                'ARRAY(' +
                    'SELECT json_build_object(\'template_id\', template_id, \'burned\', COUNT(*)) ' +
                    'FROM atomicassets_assets ' +
                    'WHERE contract = $1 AND collection_name = $2 AND owner IS NULL GROUP BY template_id' +
                ') burned_by_template, ' +
                'ARRAY(' +
                    'SELECT json_build_object(\'schema_name\', schema_name, \'burned\', COUNT(*)) ' +
                    'FROM atomicassets_assets ' +
                    'WHERE contract = $1 AND collection_name = $2 AND owner IS NULL GROUP BY schema_name' +
                ') burned_by_schema, ' +
                '(SELECT COUNT(*) FROM atomicassets_templates WHERE contract = $1 AND collection_name = $2) templates, ' +
                '(SELECT COUNT(*) FROM atomicassets_schemas WHERE contract = $1 AND collection_name = $2) "schemas"',
                [core.args.atomicassets_account, req.params.collection_name]
            );

            return res.json({success: true, data: query.rows[0]});
        } catch (e) {
            res.status(500).json({success: false, message: 'Internal Server Error'});
        }
    }));

    router.get('/v1/collections/:collection_name/logs', server.web.caching(), (async (req, res) => {
        const args = filterQueryArgs(req, {
            page: {type: 'int', min: 1, default: 1},
            limit: {type: 'int', min: 1, max: 100, default: 100},
            order: {type: 'string', values: ['asc', 'desc'], default: 'asc'}
        });

        try {
            res.json({
                success: true,
                data: await getLogs(
                    server, core.args.atomicassets_account, 'collection', req.params.collection_name,
                    (args.page - 1) * args.limit, args.limit, args.order
                ), query_time: Date.now()
            });
        } catch (e) {
            return res.status(500).json({success: false, message: 'Internal Server Error'});
        }
    }));

    return {
        tag: {
            name: 'collections',
            description: 'Collections'
        },
        paths: {
            '/v1/collections': {
                get: {
                    tags: ['collections'],
                    summary: 'Fetch collections',
                    parameters: [
                        {
                            name: 'author',
                            in: 'query',
                            description: 'Get collections by author',
                            required: false,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'match',
                            in: 'query',
                            description: 'Search for input in collection name',
                            required: false,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'authorized_account',
                            in: 'query',
                            description: 'Filter for collections which the provided account can use to create assets',
                            required: false,
                            schema: {type: 'string'}
                        },
                        {
                            name: 'notify_account',
                            in: 'query',
                            description: 'Filter for collections where the provided account is notified',
                            required: false,
                            schema: {type: 'string'}
                        },
                        ...greylistFilterParameters,
                        ...primaryBoundaryParameters,
                        ...dateBoundaryParameters,
                        ...paginationParameters,
                        {
                            name: 'sort',
                            in: 'query',
                            description: 'Column to sort',
                            required: false,
                            schema: {
                                type: 'string',
                                enum: ['created', 'collection_name'],
                                default: 'created'
                            }
                        }
                    ],
                    responses: getOpenAPI3Responses([200, 500], {type: 'array', items: {'$ref': '#/components/schemas/Collection'}})
                }
            },
            '/v1/collections/{collection_name}': {
                get: {
                    tags: ['collections'],
                    summary: 'Find collection by its name',
                    parameters: [
                        {
                            name: 'collection_name',
                            in: 'path',
                            description: 'Name of collection',
                            required: true,
                            schema: {type: 'string'}
                        }
                    ],
                    responses: getOpenAPI3Responses([200, 416, 500], {'$ref': '#/components/schemas/Collection'})
                }
            },
            '/v1/collections/{collection_name}/stats': {
                get: {
                    tags: ['collections'],
                    summary: 'Get stats about collection',
                    parameters: [
                        {
                            name: 'collection_name',
                            in: 'path',
                            description: 'Name of collection',
                            required: true,
                            schema: {type: 'string'}
                        }
                    ],
                    responses: getOpenAPI3Responses([200, 500], {
                        type: 'object',
                        properties: {
                            assets: {type: 'integer'},
                            burned: {type: 'integer'},
                            templates: {type: 'integer'},
                            schemas: {type: 'integer'}
                        }
                    })
                }
            },
            '/v1/collections/{collection_name}/logs': {
                get: {
                    tags: ['collections'],
                    summary: 'Fetch collection logs',
                    parameters: [
                        {
                            name: 'collection_name',
                            in: 'path',
                            description: 'Name of collection',
                            required: true,
                            schema: {type: 'string'}
                        },
                        ...paginationParameters
                    ],
                    responses: getOpenAPI3Responses([200, 500], {type: 'array', items: {'$ref': '#/components/schemas/Log'}})
                }
            }
        },
        definitions: {}
    };
}
