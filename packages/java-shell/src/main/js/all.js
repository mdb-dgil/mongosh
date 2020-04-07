const Mapper = require('./../../../../mapper/').default;
const ShellApiSignatures = require('../../../../shell-api/');

/** temporal object that is used to access symbols from closures generated by browserify */
_global = {
    Mapper: Mapper,
    Database: ShellApiSignatures.Database,
    Collection: ShellApiSignatures.Collection,
    Cursor: ShellApiSignatures.Cursor,
    InsertOneResult: ShellApiSignatures.InsertOneResult,
    DeleteResult: ShellApiSignatures.DeleteResult
};
