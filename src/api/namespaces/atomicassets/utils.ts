import * as express from 'express';

import { filterQueryArgs } from '../utils';
import { OfferState } from '../../../filler/handlers/atomicassets';
import { SaleState } from '../../../filler/handlers/atomicmarket';
import { HTTPServer } from '../../server';

export async function getLogs(
    server: HTTPServer, contract: string, relationName: string, relationId: string,
    offset: number = 0, limit: number = 100, order: 'asc' | 'desc' = 'asc'
): Promise<Array<{log_id: number, name: string, data: any, txid: string, created_at_block: string, created_at_time: string}>> {
    const queryStr = 'SELECT log_id, name, data, encode(txid::bytea, \'hex\') txid, created_at_block, created_at_time ' +
        'FROM atomicassets_logs ' +
        'WHERE contract = $1 AND relation_name = $2 AND relation_id = $3 ' +
        'ORDER BY log_id ' + (order === 'asc' ? 'ASC' : 'DESC') + ' LIMIT $4 OFFSET $5';

    const query = await server.query(queryStr, [contract, relationName, relationId, limit, offset]);

    return query.rows;
}

export function buildDataConditions(
    args: any, varCounter: number = 0, column: string
): {str: string, values: any[]} | null {
    const keys = Object.keys(args);

    const query: {[key: string]: string | number} = {};
    for (const key of keys) {
        if (key.startsWith('data::text.')) {
            query[key.substr('data::text.'.length)] = String(args[key]);
        } else if (key.startsWith('data::number.')) {
            query[key.substr('data::number.'.length)] = parseFloat(args[key]);
        } else if (key.startsWith('data.')) {
            query[key.substr('data.'.length)] = String(args[key]);
        }
    }

    if (Object.keys(query).length > 0) {
        return {
            str: ' ' + column + ' @> $' + ++varCounter + '::jsonb ',
            values: [JSON.stringify(query)]
        };
    }

    return null;
}

export function buildAssetFilter(
    req: express.Request, varOffset: number, assetTable?: string, templateTable?: string
): {str: string, values: any[]} {
    const args = filterQueryArgs(req, {
        owner: {type: 'string', min: 1, max: 12},
        template_id: {type: 'string', min: 1},
        collection_name: {type: 'string', min: 1},
        schema_name: {type: 'string', min: 1},
        match: {type: 'string', min: 1},
        is_transferable: {type: 'bool'},
        is_burnable: {type: 'bool'}
    });

    let queryString = '';
    let queryValues: any[] = [];
    let varCounter = varOffset;

    const conditions = [];
    if (args.collection_name) {
        const dataCondition = buildDataConditions(req.query, varCounter, '"data_table".data');

        if (dataCondition) {
            queryValues = queryValues.concat(dataCondition.values);
            varCounter += dataCondition.values.length;

            conditions.push(dataCondition.str);
        }
    }

    if (args.match) {
        conditions.push(
            '"data_table".data->>\'name\' IS NOT NULL AND ' +
            'POSITION($' + ++varCounter + ' IN LOWER("data_table".data->>\'name\')) > 0'
        );
        queryValues.push(args.match.toLowerCase());
    }

    if (conditions.length > 0) {
        queryString += 'AND EXISTS (' +
            'SELECT * FROM atomicassets_asset_data "data_table" ' +
            'WHERE "data_table".contract = ' + assetTable + '.contract AND ' +
            '"data_table".asset_id = ' + assetTable + '.asset_id AND ' + conditions.join(' AND ') +
            ') ';
    }

    if (args.owner) {
        queryString += 'AND ' + assetTable + '.owner = ANY($' + ++varCounter + ') ';
        queryValues.push(args.owner.split(','));
    }

    if (args.template_id) {
        queryString += 'AND ' + assetTable + '.template_id = ANY($' + ++varCounter + ') ';
        queryValues.push(args.template_id.split(','));
    }

    if (args.collection_name) {
        queryString += 'AND ' + assetTable + '.collection_name = ANY ($' + ++varCounter + ') ';
        queryValues.push(args.collection_name.split(','));
    }

    if (args.schema_name) {
        queryString += 'AND ' + assetTable + '.schema_name = ANY($' + ++varCounter + ') ';
        queryValues.push(args.schema_name.split(','));
    }

    if (templateTable && typeof args.is_transferable === 'boolean') {
        if (args.is_transferable) {
            queryString += 'AND (' + templateTable + '.transferable IS NULL OR  ' + templateTable + '.transferable = TRUE) ';
        } else {
            queryString += 'AND ' + templateTable + '.transferable = FALSE ';
        }
    }

    if (templateTable && typeof args.is_burnable === 'boolean') {
        if (args.is_burnable) {
            queryString += 'AND (' + templateTable + '.burnable IS NULL OR  ' + templateTable + '.burnable = TRUE) ';
        } else {
            queryString += 'AND ' + templateTable + '.burnable = FALSE ';
        }
    }

    return {
        values: queryValues,
        str: queryString
    };
}

export function buildGreylistFilter(
    req: express.Request, varOffset: number, collectionColumn: string = 'collection_name', accountColumns: string[] = []
): {str: string, values: any[]} {
    const args = filterQueryArgs(req, {
        collection_blacklist: {type: 'string', min: 1},
        collection_whitelist: {type: 'string', min: 1},
        account_blacklist: {type: 'string', min: 1}
    });

    let queryString = '';
    const queryValues: any[] = [];
    let varCounter = varOffset;

    if (args.collection_blacklist) {
        queryString += 'AND NOT (' + collectionColumn + ' = ANY ($' + ++varCounter + ')) ';
        queryValues.push(args.collection_blacklist.split(','));
    }

    if (args.collection_whitelist) {
        queryString += 'AND ' + collectionColumn + ' = ANY ($' + ++varCounter + ') ';
        queryValues.push(args.collection_whitelist.split(','));
    }

    if (args.account_blacklist) {
        const varCount = ++varCounter;
        queryValues.push(args.account_blacklist.split(','));

        for (const column of accountColumns) {
            queryString += 'AND NOT (' + column + ' = ANY ($' + varCount + ')) ';
        }
    }

    return {
        values: queryValues,
        str: queryString
    };
}

export function hideOfferAssets(req: express.Request): string {
    const args = filterQueryArgs(req, {
        hide_offers: {type: 'bool', default: false},
        hide_sales: {type: 'bool', default: false}
    });

    let queryString = '';

    if (args.hide_offers) {
        queryString += 'AND NOT EXISTS (' +
            'SELECT * FROM atomicassets_offers offer, atomicassets_offers_assets asset_o ' +
            'WHERE asset_o.contract = asset.contract AND asset_o.asset_id = asset.asset_id AND ' +
            'offer.contract = asset_o.contract AND offer.offer_id = asset_o.offer_id AND ' +
            'offer.state = ' + OfferState.PENDING.valueOf() + ' ' +
            ') ';
    }

    if (args.hide_sales) {
        queryString += 'AND NOT EXISTS (' +
            'SELECT * FROM atomicmarket_sales sale, atomicassets_offers offer, atomicassets_offers_assets asset_o ' +
            'WHERE asset_o.contract = asset.contract AND asset_o.asset_id = asset.asset_id AND ' +
            'offer.contract = asset_o.contract AND offer.offer_id = asset_o.offer_id AND ' +
            'offer.state = ' + OfferState.PENDING.valueOf() + ' AND ' +
            'sale.assets_contract = offer.contract AND sale.offer_id = offer.offer_id AND ' +
            'sale.state = ' + SaleState.LISTED.valueOf() + ' ' +
            ') ';
    }

    return queryString;
}
