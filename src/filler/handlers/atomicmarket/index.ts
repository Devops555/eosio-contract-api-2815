import * as fs from 'fs';
import { PoolClient } from 'pg';
import PQueue from 'p-queue';

import { ContractHandler } from '../interfaces';
import { ShipBlock } from '../../../types/ship';
import { EosioActionTrace, EosioTableRow, EosioTransaction } from '../../../types/eosio';
import { ContractDBTransaction } from '../../database';
import logger from '../../../utils/winston';
import { getStackTrace } from '../../../utils';
import { ConfigTableRow } from './types/tables';
import AtomicMarketTableHandler from './tables';
import AtomicMarketActionHandler from './actions';
import StateReceiver from '../../receiver';

export type AtomicMarketArgs = {
    atomicmarket_account: string,
    atomicassets_account: string,
    delphioracle_account: string
};

export enum SaleState {
    WAITING = 0,
    LISTED = 1,
    CANCELED = 2,
    SOLD = 3
}

export enum AuctionState {
    WAITING = 0,
    LISTED = 1,
    CANCELED = 2
}

export enum JobPriority {
    TABLE_BALANCES = 90,
    TABLE_MARKETPLACES = 90,
    TABLE_CONFIG = 90,
    ACTION_CREATE_SALE = 80,
    ACTION_CREATE_AUCTION = 80,
    TABLE_AUCTIONS = 70,
    TABLE_SALES = 70,
    ACTION_UPDATE_SALE = 50,
    ACTION_UPDATE_AUCTION = 50
}

export default class AtomicMarketHandler extends ContractHandler {
    static handlerName = 'atomicmarket';

    readonly args: AtomicMarketArgs;

    config: ConfigTableRow;

    reversible = false;

    updateQueue: PQueue;
    updateJobs: any[] = [];

    notificationQueue: PQueue;
    notificationJobs: any[] = [];

    tableHandler: AtomicMarketTableHandler;
    actionHandler: AtomicMarketActionHandler;

    constructor(reader: StateReceiver, args: {[key: string]: any}, minBlock: number = 0) {
        super(reader, args, minBlock);

        if (typeof args.atomicmarket_account !== 'string') {
            throw new Error('AtomicMarket: Argument missing in atomicmarket handler: atomicmarket_account');
        }

        this.updateQueue = new PQueue({concurrency: 1, autoStart: false});
        this.updateQueue.pause();

        this.notificationQueue = new PQueue({concurrency: 1, autoStart: false});
        this.notificationQueue.pause();

        this.scope = {
            actions: [
                {
                    filter: this.args.atomicmarket_account + ':*',
                    deserialize: true
                }
            ],
            tables: [
                {
                    filter: this.args.atomicmarket_account + ':*',
                    deserialize: true
                }
            ]
        };

        this.tableHandler = new AtomicMarketTableHandler(this);
        this.actionHandler = new AtomicMarketActionHandler(this);
    }

    async init(client: PoolClient): Promise<void> {
        const existsQuery = await client.query(
            'SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2)',
            [await this.connection.database.schema(), 'atomicmarket_config']
        );

        if (!existsQuery.rows[0].exists) {
            logger.info('Could not find AtomicMarket tables. Create them now...');

            await client.query(fs.readFileSync('./definitions/tables/atomicmarket_tables.sql', {
                encoding: 'utf8'
            }));

            logger.info('AtomicMarket tables successfully created');
        }

        const views = ['atomicmarket_assets_master', 'atomicmarket_auctions_master', 'atomicmarket_sales_master'];

        for (const view of views) {
            await client.query(fs.readFileSync('./definitions/views/' + view + '.sql', {encoding: 'utf8'}));
        }

        const configQuery = await client.query(
            'SELECT * FROM atomicmarket_config WHERE market_contract = $1',
            [this.args.atomicmarket_account]
        );

        if (configQuery === null || configQuery.rows.length === 0) {
            const configTable = await this.connection.chain.rpc.get_table_rows({
                json: true, code: this.args.atomicmarket_account,
                scope: this.args.atomicmarket_account, table: 'config'
            });

            if (configTable.rows.length === 0) {
                throw new Error('AtomicMarket: Unable to fetch atomicmarket version');
            }

            const config: ConfigTableRow = configTable.rows[0];

            this.args.delphioracle_account = config.delphioracle_account;
            this.args.atomicassets_account = config.atomicassets_account;

            await client.query(
                'INSERT INTO atomicmarket_config ' +
                '(' +
                    'market_contract, asset_contract, delphi_contract, ' +
                    'version, maker_market_fee, taker_market_fee, ' +
                    'minimum_auction_duration, maximum_auction_duration, ' +
                    'minimum_bid_increase, auction_reset_duration' +
                ') ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                [
                    this.args.atomicmarket_account,
                    this.args.atomicassets_account,
                    config.delphioracle_account,
                    config.version,
                    config.maker_market_fee,
                    config.taker_market_fee,
                    config.minimum_auction_duration,
                    config.maximum_auction_duration,
                    config.minimum_bid_increase,
                    config.auction_reset_duration
                ]
            );

            this.config = {
                ...config,
                supported_symbol_pairs: [],
                supported_tokens: []
            };
        } else {
            this.args.delphioracle_account = configQuery.rows[0].delphi_contract;
            this.args.atomicassets_account = configQuery.rows[0].asset_contract;

            const tokensQuery = await this.connection.database.query(
                'SELECT * FROM atomicmarket_tokens WHERE market_contract = $1',
                [this.args.atomicmarket_account]
            );

            const pairsQuery = await this.connection.database.query(
                'SELECT * FROM atomicmarket_symbol_pairs WHERE market_contract = $1',
                [this.args.atomicmarket_account]
            );

            this.config = {
                ...configQuery.rows[0],
                supported_symbol_pairs: pairsQuery.rows.map(row => ({
                    listing_symbol: 'X,' + row.listing_symbol,
                    settlement_symbol: 'X,' + row.settlement_symbol,
                    invert_delphi_pair: row.invert_delphi_pair,
                    delphi_pair_name: row.delphi_pair_name
                })),
                supported_tokens: tokensQuery.rows.map(row => ({
                    token_contract: row.token_contract,
                    token_symbol: row.token_precision + ',' + row.token_symbol
                })),
                auction_counter: 0,
                sale_counter: 0,
                delphioracle_account: this.args.delphioracle_account,
                atomicassets_account: this.args.atomicassets_account
            };
        }
    }

    async deleteDB(client: PoolClient): Promise<void> {
        const tables = [
            'atomicmarket_auctions', 'atomicmarket_auctions_bids', 'atomicmarket_config',
            'atomicmarket_delphi_pairs', 'atomicmarket_marketplaces', 'atomicmarket_sales',
            'atomicmarket_token_symbols'
        ];

        for (const table of tables) {
            await client.query(
                'DELETE FROM ' + client.escapeIdentifier(table) + ' WHERE market_contract = $1',
                [this.args.atomicmarket_account]
            );
        }
    }

    async onAction(db: ContractDBTransaction, block: ShipBlock, trace: EosioActionTrace, tx: EosioTransaction): Promise<void> {
        await this.actionHandler.handleTrace(db, block, trace, tx);
    }

    async onTableChange(db: ContractDBTransaction, block: ShipBlock, delta: EosioTableRow): Promise<void> {
        await this.tableHandler.handleUpdate(db, block, delta);
    }

    async onBlockComplete(db: ContractDBTransaction): Promise<void> {
        this.reversible = db.currentBlock > db.lastIrreversibleBlock;

        this.updateQueue.start();
        await Promise.all(this.updateJobs);
        this.updateQueue.pause();
        this.updateJobs = [];
    }

    async onCommit(): Promise<void> {
        this.notificationQueue.start();
        await Promise.all(this.notificationJobs);
        this.notificationQueue.pause();
        this.notificationJobs = [];
    }

    async onBlockStart(): Promise<void> { }

    addUpdateJob(fn: () => any, priority: JobPriority): void {
        const trace = getStackTrace();

        this.updateJobs.push(this.updateQueue.add(async () => {
            try {
                await fn();
            } catch (e) {
                logger.error(e);
                logger.error(trace);

                throw e;
            }
        }, {priority: priority.valueOf()}));
    }

    pushNotificiation(block: ShipBlock, tx: EosioTransaction | null, prefix: string, name: string, data: any): void {
        if (!this.reversible) {
            return;
        }

        const trace = getStackTrace();

        this.notificationJobs.push(this.notificationQueue.add(async () => {
            try {
                const channelName = [
                    'eosio-contract-api', this.connection.chain.name, this.reader.name,
                    'atomicmarket', this.args.atomicmarket_account, prefix
                ].join(':');

                await this.connection.redis.ioRedis.publish(channelName, JSON.stringify({
                    transaction: tx,
                    block: {block_num: block.block_num, block_id: block.block_id},
                    action: name, data
                }));
            } catch (e) {
                logger.warn('Error while pushing notification', trace);
            }
        }));
    }
}
