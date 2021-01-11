import {
  Auth,
  AuthMechanismId,
  MongoClient,
  ReadPreference,
  Binary,
  Code,
  DBRef,
  Double,
  Int32,
  Long,
  MinKey,
  MaxKey,
  ObjectId,
  Timestamp,
  Decimal128,
  Map,
  BSONSymbol,
  ClientMetadata,
  Topology
} from 'mongodb';

import {
  ServiceProvider,
  getConnectInfo,
  ReplPlatform,
  DEFAULT_DB,
  ServiceProviderCore,
  ShellAuthOptions,
  // Driver types:
  AggregateOptions,
  AggregationCursor,
  AnyBulkWriteOperation,
  BulkWriteOptions,
  BulkWriteResult,
  ClientSessionOptions,
  CollStatsOptions,
  Collection,
  CountDocumentsOptions,
  CountOptions,
  CreateCollectionOptions,
  CreateIndexesOptions,
  FindCursor,
  Db,
  DbOptions,
  DeleteOptions,
  DeleteResult,
  DistinctOptions,
  Document,
  DropCollectionOptions,
  DropDatabaseOptions,
  EstimatedDocumentCountOptions,
  FindAndModifyOptions,
  FindOptions,
  IndexDescription,
  InsertManyResult,
  InsertOneOptions,
  InsertOneResult,
  ListCollectionsOptions,
  ListDatabasesOptions,
  ListIndexesOptions,
  MongoClientOptions,
  ReadConcern,
  RenameOptions,
  ReplaceOptions,
  RunCommandOptions,
  ClientSession,
  UpdateOptions,
  UpdateResult,
  WriteConcern,
  ChangeStreamOptions,
  ChangeStream,
  bson as BSON
} from '@mongosh/service-provider-core';

import { MongoshCommandFailed, MongoshInternalError } from '@mongosh/errors';
import { URL } from 'url';

const bsonlib = {
  Binary,
  Code,
  DBRef,
  Double,
  Int32,
  Long,
  MinKey,
  MaxKey,
  ObjectId,
  Timestamp,
  Decimal128,
  Map,
  BSONSymbol,
  calculateObjectSize: BSON.calculateObjectSize
};

type DropDatabaseResult = {
  ok: 0 | 1;
  dropped?: string;
};

type ConnectionInfo = {
  buildInfo: any;
  topology: Topology;
  extraInfo: ExtraConnectionInfo;
};
type ExtraConnectionInfo = ReturnType<typeof getConnectInfo>;

/**
 * Default driver options we always use.
 */
const DEFAULT_DRIVER_OPTIONS = Object.freeze({
});

function processDriverOptions(opts: MongoClientOptions): MongoClientOptions {
  const ret = { ...DEFAULT_DRIVER_OPTIONS, ...opts };
  if (ret.tlsCertificateKeyFile && !ret.tlsCertificateFile) {
    ret.tlsCertificateFile = ret.tlsCertificateKeyFile;
  }
  return ret;
}

/**
 * Default driver method options we always use.
 */
const DEFAULT_BASE_OPTIONS = Object.freeze({
  serializeFunctions: true
});

/**
 * Encapsulates logic for the service provider for the mongosh CLI.
 */
class CliServiceProvider extends ServiceProviderCore implements ServiceProvider {
  /**
   * Create a new CLI service provider from the provided URI.
   *
   * @param {String} uri - The URI.
   * @param {MongoClientOptions} driverOptions - The options.
   * @param {Object} cliOptions - Options passed through CLI. Right now only being used for nodb.
   *
   * @returns {Promise} The promise with cli service provider.
   */
  static async connect(
    uri: string,
    driverOptions: MongoClientOptions = {},
    cliOptions: { nodb?: boolean } = {}
  ): Promise<CliServiceProvider> {
    const clientOptions = processDriverOptions(driverOptions);

    const mongoClient = !cliOptions.nodb ?
      await MongoClient.connect(
        uri,
        clientOptions
      ) :
      new MongoClient(uri || 'mongodb://nodb/', clientOptions);

    return new CliServiceProvider(mongoClient, clientOptions, uri);
  }

  public readonly platform: ReplPlatform;
  public readonly initialDb: string;
  public mongoClient: MongoClient; // public for testing
  private readonly uri?: string;
  private initialOptions: MongoClientOptions;
  private dbcache: WeakMap<MongoClient, Map<string, Db>>;
  public baseCmdOptions: any; // public for testing
  public fle: any;

  /**
   * Instantiate a new CliServiceProvider with the Node driver's connected
   * MongoClient instance.
   *
   * @param {MongoClient} mongoClient - The Node drivers' MongoClient instance.
   * @param clientOptions
   * @param {string} uri - optional URI for telemetry.
   */
  constructor(mongoClient: MongoClient, clientOptions = {}, uri?: string) {
    super(bsonlib);
    this.mongoClient = mongoClient;
    this.uri = uri;
    this.platform = ReplPlatform.CLI;
    try {
      this.initialDb = (mongoClient as any).s.options.dbName || DEFAULT_DB;
    } catch (err) {
      this.initialDb = DEFAULT_DB;
    }
    this.initialOptions = clientOptions;
    this.baseCmdOptions = { ... DEFAULT_BASE_OPTIONS }; // currently do not have any user-specified connection-wide command options, but I imagine we will eventually
    this.dbcache = new WeakMap();
    try {
      this.fle = require('mongodb-client-encryption');
    } catch { /* not empty */ }
  }

  async getNewConnection(uri: string, options: MongoClientOptions = {}): Promise<CliServiceProvider> {
    const clientOptions = processDriverOptions(options);

    const mongoClient = await MongoClient.connect(
      uri,
      clientOptions
    );
    return new CliServiceProvider(mongoClient, uri);
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    const buildInfo = await this.runCommandWithCheck('admin', {
      buildInfo: 1
    }, this.baseCmdOptions);
    const topology = this.getTopology() as Topology;
    const { version } = require('../package.json');
    let cmdLineOpts = null;
    try {
      cmdLineOpts = await this.runCommandWithCheck('admin', {
        getCmdLineOpts: 1
      }, this.baseCmdOptions);
      // eslint-disable-next-line no-empty
    } catch (e) {
    }

    const extraConnectionInfo = getConnectInfo(
      this.uri ? this.uri : '',
      version,
      buildInfo,
      cmdLineOpts,
      topology
    );

    return {
      buildInfo: buildInfo,
      topology: topology,
      extraInfo: extraConnectionInfo
    };
  }

  async renameCollection(
    database: string,
    oldName: string,
    newName: string,
    options: RenameOptions = {},
    dbOptions?: DbOptions): Promise<Collection> {
    options = { ...this.baseCmdOptions, ...options };
    return await this.db(database, dbOptions).renameCollection(oldName, newName, options);
  }

  async findAndModify(
    database: string,
    collection: string,
    query: Document,
    sort: any[] | Document | undefined,
    update: Document | undefined,
    options: FindAndModifyOptions = {},
    dbOptions?: DbOptions
  ): Promise<Document> {
    options = { ...this.baseCmdOptions, ...options };
    return await (this.db(database, dbOptions)
      .collection(collection) as any)
      .findAndModify(query, sort, update, options);
  }

  /**
   * Get the Db object from the client.
   *
   * @param {String} name - The database name.
   * @param dbOptions
   *
   * @returns {Db} The database.
   */
  private db(name: string, dbOptions: DbOptions = {}): Db {
    const key = `${name}-${JSON.stringify(dbOptions)}`;
    const dbcache = this.getDBCache();
    const cached = dbcache.get(key);
    if (cached) {
      return cached;
    }
    const db = this.mongoClient.db(name, dbOptions);
    dbcache.set(key, db);
    return db;
  }

  /**
   * Wrapper to make this available for testing.
   */
  _dbTestWrapper(name: string, dbOptions?: DbOptions): Db {
    return this.db(name, dbOptions);
  }

  /**
   * Return the db cache for the current MongoClient.
   */
  private getDBCache(): Map<string, Db> {
    const existing = this.dbcache.get(this.mongoClient);
    if (existing) {
      return existing;
    }
    this.dbcache.set(this.mongoClient, new Map());
    return this.getDBCache();
  }

  /**
   * Run an aggregation pipeline.
   *
   * @param {String} database - the db name
   * @param {String} collection - the collection name
   * @param pipeline
   * @param options
   *    allowDiskUse: Optional<Boolean>;
   *    batchSize: Optional<Int32>;
   *    bypassDocumentValidation: Optional<Boolean>;
   *    collation: Optional<Document>;
   *    maxTimeMS: Optional<Int64>;
   *    maxAwaitTimeMS: Optional<Int64>;
   *    comment: Optional<String>;
   *    hint: Optional<(String | Document = {})>;
   * @param dbOptions

   * @returns {Cursor} The aggregation cursor.
   */
  aggregate(
    database: string,
    collection: string,
    pipeline: Document[] = [],
    options: AggregateOptions = {},
    dbOptions?: DbOptions): AggregationCursor {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .aggregate(pipeline, options);
  }

  /**
   * @param {String} database - the db name
   * @param pipeline
   * @param options
   *    allowDiskUse: Optional<Boolean>;
   *    batchSize: Optional<Int32>;
   *    bypassDocumentValidation: Optional<Boolean>;
   *    collation: Optional<Document>;
   *    maxTimeMS: Optional<Int64>;
   *    maxAwaitTimeMS: Optional<Int64>;
   *    comment: Optional<String>;
   *    hint: Optional<(String | Document = {})>;
   * @param dbOptions
   *      j: Optional<Boolean>
   *      w: Optional<Int32 | String>
   *      wtimeoutMS: Optional<Int64>
   * @return {any}
   */
  aggregateDb(
    database: string,
    pipeline: Document[] = [],
    options: AggregateOptions = {},
    dbOptions?: DbOptions): AggregationCursor {
    options = { ...this.baseCmdOptions, ...options };
    const db: any = (this.db(database, dbOptions) as any);
    return db.aggregate(pipeline, options);
  }

  /**
   * @param {String} database - the db name
   * @param {String} collection - the collection name
   * @param requests
   * @param options
   *      ordered: Boolean;
   *      bypassDocumentValidation: Optional<Boolean>;
   * @param dbOptions
   *      j: Optional<Boolean>
   *      w: Optional<Int32 | String>
   *      wtimeoutMS: Optional<Int64>
   *    readConcern:
   *        level: <String local|majority|linearizable|available>
   * @return {any}
   */
  bulkWrite(
    database: string,
    collection: string,
    requests: AnyBulkWriteOperation[],
    options: BulkWriteOptions = {},
    dbOptions?: DbOptions): Promise<BulkWriteResult> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .bulkWrite(requests, options);
  }

  /**
   * Close the connection.
   *
   * @param {boolean} force - Whether to force close the connection.
   */
  close(force: boolean): Promise<void> {
    this.dbcache.set(this.mongoClient, new Map());
    return this.mongoClient.close(force);
  }

  /**
   * Deprecated count command.
   *
   * @param {String} database - the db name
   * @param {String} collection - the collection name
   * @param query
   * @param options
   *    collation: Optional<Document>
   *    hint: Optional<(String | Document = {})>;
   *    limit: Optional<Int64>;
   *    maxTimeMS: Optional<Int64>;
   *    skip: Optional<Int64>;
   * @param dbOptions
   *    readConcern:
   *        level: <String local|majority|linearizable|available>
   * @return {Promise<any>}
   */
  count(
    database: string,
    collection: string,
    query: Document = {},
    options: CountOptions = {},
    dbOptions?: DbOptions): Promise<number> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .count(query, options);
  }

  /**
   * Get an exact document count from the collection.
   *
   * @param {String} database - the db name
   * @param {String} collection - the collection name
   * @param filter
   * @param options
   *    hint: Optional<(String | Document = {})>;
   *    limit: Optional<Int64>;
   *    maxTimeMS: Optional<Int64>;
   *    skip: Optional<Int64>;
   * @param dbOptions
   * @return {any}
   */
  countDocuments(
    database: string,
    collection: string,
    filter: Document = {},
    options: CountDocumentsOptions = {},
    dbOptions?: DbOptions): Promise<number> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .countDocuments(filter, options);
  }

  /**
   * Delete multiple documents from the collection.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {Object} filter - The filter.
   * @param {Object} options - The delete many options.
   * @param {Object} dbOptions - The database options (i.e. readConcern, writeConcern. etc).
   *
   * @returns {Promise} The promise of the result.
   */
  deleteMany(
    database: string,
    collection: string,
    filter: Document = {},
    options: DeleteOptions = {},
    dbOptions?: DbOptions): Promise<DeleteResult> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .deleteMany(filter, options);
  }

  /**
   * Delete one document from the collection.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {Object} filter - The filter.
   * @param {Object} options - The delete one options.
   * @param {Object} dbOptions - The database options (i.e. readConcern, writeConcern. etc).
   *
   * @returns {Promise} The promise of the result.
   */
  deleteOne(
    database: string,
    collection: string,
    filter: Document = {},
    options: DeleteOptions = {},
    dbOptions?: DbOptions): Promise<DeleteResult> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .deleteOne(filter, options);
  }

  /**
   * Get distinct values for the field.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {String} fieldName - The field name.
   * @param {Object} filter - The filter.
   * @param {Object} options - The distinct options.
   * @param {Object} dbOptions - The database options (i.e. readConcern, writeConcern. etc).
   *
   * @returns {Cursor} The cursor.
   */
  distinct(
    database: string,
    collection: string,
    fieldName: string,
    filter: Document = {},
    options: DistinctOptions = {},
    dbOptions?: DbOptions): Promise<Document[]> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .distinct(fieldName, filter, options);
  }

  /**
   * Get an estimated document count from the collection.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {Object} options - The count options.
   * @param {Object} dbOptions - The database options (i.e. readConcern, writeConcern. etc).
   *
   * @returns {Promise} The promise of the result.
   */
  estimatedDocumentCount(
    database: string,
    collection: string,
    options: EstimatedDocumentCountOptions = {},
    dbOptions?: DbOptions): Promise<number> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .estimatedDocumentCount(options);
  }

  /**
   * Find documents in the collection.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {Object} filter - The filter.
   * @param {Object} options - The find options.
   *
   * @param dbOptions
   * @returns {Cursor} The cursor.
   */
  find(
    database: string,
    collection: string,
    filter: Document = {},
    options: FindOptions = {},
    dbOptions?: DbOptions): FindCursor {
    const findOptions: any = { ...this.baseCmdOptions, ...options };
    if ('allowPartialResults' in findOptions) {
      findOptions.partial = findOptions.allowPartialResults;
    }
    if ('noCursorTimeout' in findOptions) {
      findOptions.timeout = findOptions.noCursorTimeout;
    }
    return this.db(database, dbOptions)
      .collection(collection)
      .find(filter, findOptions);
  }

  /**
   * Find one document and delete it.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {Object} filter - The filter.
   * @param {Object} options - The find options.
   * @param {Object} dbOptions - The database options (i.e. readConcern, writeConcern. etc).
   *
   * @returns {Promise} The promise of the result.
   */
  findOneAndDelete(
    database: string,
    collection: string,
    filter: Document = {},
    options: FindAndModifyOptions = {},
    dbOptions?: DbOptions): Promise<Document> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection).
      findOneAndDelete(filter, options);
  }

  /**
   * Find one document and replace it.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {Object} filter - The filter.
   * @param {Object} replacement - The replacement.
   * @param {Object} options - The find options.
   *
   * @param dbOptions
   * @returns {Promise} The promise of the result.
   */
  findOneAndReplace(
    database: string,
    collection: string,
    filter: Document = {},
    replacement: Document = {},
    options: FindAndModifyOptions = {},
    dbOptions?: DbOptions): Promise<Document> {
    const findOneAndReplaceOptions: any = { ...this.baseCmdOptions, ...options };

    return (
      this.db(database, dbOptions).collection(collection) as any
    ).findOneAndReplace(filter, replacement, findOneAndReplaceOptions);
  }

  /**
   * Find one document and update it.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {Object} filter - The filter.
   * @param {(Object|Array)} update - The update.
   * @param {Object} options - The find options.
   *
   * @param dbOptions
   * @returns {Promise} The promise of the result.
   */
  findOneAndUpdate(
    database: string,
    collection: string,
    filter: Document = {},
    update: Document = {},
    options: FindAndModifyOptions = {},
    dbOptions?: DbOptions): Promise<Document> {
    const findOneAndUpdateOptions = { ...this.baseCmdOptions, ...options };

    return this.db(database, dbOptions)
      .collection(collection)
      .findOneAndUpdate(
        filter,
        update,
        findOneAndUpdateOptions
      ) as any;
  }

  /**
   * Insert many documents into the collection.
   *
   * @param {string} database - The database name.
   * @param {string} collection - The collection name.
   * @param {Document[]} [docs=[]] - The documents.
   * @param {Document} [options={}] - options - The insert many options.
   * @param {DbOptions} [dbOptions] - The database options.
   *
   * @returns {Promise<InsertManyResult>}
   */
  insertMany(
    database: string,
    collection: string,
    docs: Document[] = [],
    options: BulkWriteOptions = {},
    dbOptions?: DbOptions): Promise<InsertManyResult> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .insertMany(docs, options);
  }

  /**
   * Insert one document into the collection.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {Object} doc - The document.
   * @param {Object} options - The insert one options.
   * @param {Object} dbOptions - The database options (i.e. readConcern, writeConcern. etc).
   *
   * @returns {Promise} The promise of the result.
   */
  async insertOne(
    database: string,
    collection: string,
    doc: Document = {},
    options: InsertOneOptions = {},
    dbOptions?: DbOptions): Promise<InsertOneResult> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .insertOne(doc, options);
  }

  /**
   * Is the collection capped?
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param dbOptions
   * @returns {Promise} The promise of the result.
   */
  isCapped(
    database: string,
    collection: string,
    dbOptions?: DbOptions): Promise<boolean> {
    return this.db(database, dbOptions).collection(collection).isCapped();
  }

  /**
   * Deprecated remove command.
   *
   * @param {String} database - The db name.
   * @param {String} collection - The collection name.
   * @param {Object} query - The query.
   * @param {Object} options - The options.
   * @param dbOptions
   * @return {Promise}
   */
  remove(
    database: string,
    collection: string,
    query: Document = {},
    options: DeleteOptions = {},
    dbOptions?: DbOptions): Promise<DeleteResult> {
    options = { ...this.baseCmdOptions, ...options };
    /* NOTE: the 4.x branch of the driver does not define a separate def for remove that doesn't take a
       callback, and since remove is deprecated it's not worth asking for a change to the driver. So ts-ignore it is.
    */
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return this.db(database, dbOptions).collection(collection).remove(query, options);
  }

  /**
   * Replace a document with another.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {Object} filter - The filter.
   * @param {Object} replacement - The replacement document for matches.
   * @param {Object} options - The replace options.
   * @param {Object} dbOptions - The database options (i.e. readConcern, writeConcern. etc).
   *
   * @returns {Promise} The promise of the result.
   */
  replaceOne(
    database: string,
    collection: string,
    filter: Document = {},
    replacement: Document = {},
    options: ReplaceOptions = {},
    dbOptions?: DbOptions
  ): Promise<UpdateResult> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .replaceOne(filter, replacement, options) as Promise<UpdateResult>;
    // `as UpdateResult` because we know we didn't request .explain() here.
  }

  /**
   * Run a command against the database.
   *
   * @param {String} database - The database name.
   * @param {Object} spec - The command specification.
   * @param {Object} options - The database options.
   * @param {Object} dbOptions - The connection-wide database options.
   *
   * @returns {Promise} The promise of command results.
   */
  runCommand(
    database: string,
    spec: Document = {},
    options: RunCommandOptions = {},
    dbOptions?: DbOptions
  ): Promise<Document> {
    options = { ...this.baseCmdOptions, ...options };
    const db = this.db(database, dbOptions);
    return db.command(
      spec,
      options
    );
  }

  /**
   * Run a command against the database and check the results for ok: 0.
   *
   * @param {String} database - The database name.
   * @param {Object} spec - The command specification.
   * @param {Object} options - The database options.
   * @param {Object} dbOptions - The connection-wide database options.
   *
   * @returns {Promise} The promise of command results.
   */
  async runCommandWithCheck(
    database: string,
    spec: Document = {},
    options: RunCommandOptions = {},
    dbOptions?: DbOptions
  ): Promise<Document> {
    const result = await this.runCommand(database, spec, options, dbOptions);
    if (result.ok === 0) {
      throw new MongoshCommandFailed(JSON.stringify(spec));
    }
    return result as { ok: 1 };
  }

  /**
   * list databases.
   *
   * @param {String} database - The database name.
   *
   * @returns {Promise} The promise of command results.
   */
  listDatabases(database: string): Promise<Document> {
    return this.db(database).admin().listDatabases(this.baseCmdOptions as ListDatabasesOptions);
  }

  /**
   * Update many document.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {Object} filter - The filter.
   * @param {(Object|Array)} update - The updates.
   * @param {Object} options - The update options.
   * @param {Object} dbOptions - The database options (i.e. readConcern, writeConcern. etc).
   *
   * @returns {Promise} The promise of the result.
   */
  async updateMany(
    database: string,
    collection: string,
    filter: Document = {},
    update: Document = {},
    options: UpdateOptions = {},
    dbOptions?: DbOptions): Promise<UpdateResult> {
    options = { ...this.baseCmdOptions, ...options };
    return await this.db(database, dbOptions)
      .collection(collection)
      .updateMany(filter, update, options) as Promise<UpdateResult>;
    // `as UpdateResult` because we know we didn't request .explain() here.
  }

  /**
   * Update a document.
   *
   * @param {String} database - The database name.
   * @param {String} collection - The collection name.
   * @param {Object} filter - The filter.
   * @param {(Object|Array)} update - The updates.
   * @param {Object} options - The update options.
   * @param {Object} dbOptions - The database options (i.e. readConcern, writeConcern. etc).
   *
   * @returns {Promise} The promise of the result.
   */
  updateOne(
    database: string,
    collection: string,
    filter: Document = {},
    update: Document = {},
    options: UpdateOptions = {},
    dbOptions?: DbOptions): Promise<UpdateResult> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .updateOne(filter, update, options) as Promise<UpdateResult>;
    // `as UpdateResult` because we know we didn't request .explain() here.
  }

  /**
   * Get currently known topology information.
   */
  getTopology(): Topology | undefined {
    return this.mongoClient.topology;
  }

  /**
   * Drop a database
   *
   * @param {String} db - The database name.
   * @param {Document} options - The write concern.
   *
   * @param dbOptions
   * @returns {Promise<Document>} The result of the operation.
   */
  async dropDatabase(
    db: string,
    options: DropDatabaseOptions = {},
    dbOptions: DbOptions = {}
  ): Promise<DropDatabaseResult> {
    const opts = { ...this.baseCmdOptions, ...options } as DropDatabaseOptions;
    const nativeResult = await this.db(db, dbOptions).dropDatabase(opts);

    const ok = nativeResult ? 1 : 0;
    return {
      ok,
      ...(ok ? { dropped: db } : {})
    };
  }

  /**
   * Adds new indexes to a collection.
   *
   * @param {String} database - The db name.
   * @param {String} collection - The collection name.
   * @param {Object[]} indexSpecs the spec of the intexes to be created.
   * @param {Object} options - The command options.
   * @param {Object} dbOptions - The database options (i.e. readConcern, writeConcern. etc).
   * @return {Promise}
   */
  async createIndexes(
    database: string,
    collection: string,
    indexSpecs: IndexDescription[],
    options: CreateIndexesOptions = {},
    dbOptions?: DbOptions): Promise<string[]> {
    options = { ...this.baseCmdOptions, ...options };
    return this.db(database, dbOptions)
      .collection(collection)
      .createIndexes(indexSpecs, options);
  }

  /**
   * Returns an array that holds a list of documents that identify and
   * describe the existing indexes on the collection.
   *
   * @param {String} database - The db name.
   * @param {String} collection - The collection name.
   * @param options
   * @param {Object} dbOptions - The database options
   *  (i.e. readConcern, writeConcern. etc).
   *
   * @return {Promise}
   */
  async getIndexes(
    database: string,
    collection: string,
    options: ListIndexesOptions = {},
    dbOptions?: DbOptions): Promise<Document[]> {
    return this.db(database, dbOptions)
      .collection(collection)
      .listIndexes({ ...this.baseCmdOptions, ...options })
      .toArray();
  }

  /**
   * Returns an array of collection infos
   *
   * @param {String} database - The db name.
   * @param {Document} filter - The filter.
   * @param {Document} options - The command options.
   * @param {Object} dbOptions - The database options
   *  (i.e. readConcern, writeConcern. etc).
   *
   * @return {Promise}
   */
  async listCollections(
    database: string,
    filter: Document = {},
    options: ListCollectionsOptions = {},
    dbOptions?: DbOptions): Promise<Document[]> {
    options = { ...this.baseCmdOptions, ...options };
    return await this.db(database, dbOptions).listCollections(
      filter, options
    ).toArray();
  }

  /**
   * Get all the collection statistics.
   *
   * @param {String} database - The db name.
   * @param {String} collection - The collection name.
   * @param {Object} options - The count options.
   * @param {Object} dbOptions - The database options
   * @return {Promise} returns Promise
   */
  async stats(
    database: string,
    collection: string,
    options: CollStatsOptions = {},
    dbOptions?: DbOptions): Promise<Document> {
    options = { ...this.baseCmdOptions, ...options };
    return await this.db(database, dbOptions)
      .collection(collection)
      .stats(options as { scale: 1 });
  }

  /**
   * Drops a the collection.
   *
   * @param {String} database - The db name.
   * @param {String} collection - The collection name.
   * @param options
   * @param {Object} dbOptions - The database options (i.e. readConcern, writeConcern. etc).
   *
   * @return {Promise}
   */
  async dropCollection(
    database: string,
    collection: string,
    options: DropCollectionOptions = {},
    dbOptions?: DbOptions
  ): Promise<boolean> {
    return this.db(database, dbOptions)
      .collection(collection)
      .drop({ ...this.baseCmdOptions, ...options } as DropCollectionOptions);
  }

  /**
   * Authenticate
   *
   * @param authDoc
   */
  async authenticate(
    authDoc: ShellAuthOptions
  ): Promise<{ ok: number }> {
    const auth: Auth = { username: authDoc.user, password: authDoc.pwd };
    // NOTE: we keep all the original options and just overwrite the auth ones.
    const clientOptions = processDriverOptions({
      ...this.initialOptions,
      auth
    });
    if (authDoc.mechanism) clientOptions.authMechanism = authDoc.mechanism as AuthMechanismId;
    if (authDoc.authDb) clientOptions.authSource = authDoc.authDb;
    const mc = await MongoClient.connect(
      Object.assign(new URL(this.uri as string), { username: '', password: '' }).href,
      clientOptions
    );
    try {
      await this.mongoClient.close();
      // eslint-disable-next-line no-empty
    } catch {}
    this.mongoClient = mc;
    return { ok: 1 };
  }

  async createCollection(
    dbName: string,
    collName: string,
    options: CreateCollectionOptions = {},
    dbOptions?: DbOptions
  ): Promise<{ ok: number }> {
    await this.db(dbName, dbOptions).createCollection(
      collName, options
    );
    return { ok: 1 };
  }

  async initializeBulkOp(
    dbName: string,
    collName: string,
    ordered: boolean,
    options: BulkWriteOptions = {},
    dbOptions?: any
  ): Promise<any> { // Node 4.0 returns any type for bulk ops.
    if (ordered) {
      return await this.db(dbName, dbOptions).collection(collName).initializeOrderedBulkOp(options);
    }
    return await this.db(dbName, dbOptions).collection(collName).initializeUnorderedBulkOp(options);
  }

  getReadPreference(): ReadPreference {
    return this.mongoClient.readPreference;
  }

  getReadConcern(): ReadConcern | undefined {
    return this.mongoClient.readConcern;
  }

  getWriteConcern(): WriteConcern | undefined {
    return this.mongoClient.writeConcern;
  }

  /**
   * For instances where a user wants to set a option that requires a new MongoClient.
   *
   * @param options
   */
  async resetConnectionOptions(options: Document): Promise<void> {
    // NOTE: we keep all the original options and just overwrite the passed.
    if (options.readPreference !== undefined) {
      const pr = new ReadPreference(
        options.readPreference.mode,
        options.readPreference.tagSet,
        options.hedgeOptions
      );
      options.readPreference = pr;
    }
    const clientOptions = processDriverOptions({
      ...this.initialOptions,
      ...options
    });
    const mc = await MongoClient.connect(
      this.uri as string,
      clientOptions
    );
    try {
      await this.mongoClient.close();
      // eslint-disable-next-line no-empty
    } catch {}
    this.mongoClient = mc;
  }

  startSession(options: ClientSessionOptions): ClientSession {
    return this.mongoClient.startSession(options);
  }

  watch(pipeline: Document[], options: ChangeStreamOptions, dbOptions: DbOptions = {}, db?: string, coll?: string): ChangeStream {
    if (db === undefined && coll === undefined) { // TODO: watch not exported, see NODE-2934
      return (this.mongoClient as any).watch(pipeline, options);
    } else if (db !== undefined && coll === undefined) {
      return (this.db(db, dbOptions) as any).watch(pipeline, options);
    } else if (db !== undefined && coll !== undefined) {
      return (this.db(db, dbOptions).collection(coll) as any).watch(pipeline, options);
    }
    throw new MongoshInternalError('Cannot call watch with defined collection but undefined db');
  }

  get driverMetadata(): ClientMetadata | undefined {
    return this.getTopology()?.clientMetadata;
  }

  getRawClient(): MongoClient {
    return this.mongoClient;
  }
}

export default CliServiceProvider;
