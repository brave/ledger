var mongodb = require('mongodb')
var GridStore = mongodb.GridStore
var GridStream = require('gridfs-stream')
var monk = require('monk')
var debug = new (require('sdebug'))('database')
var underscore = require('underscore')

var DB = function (config) {
  if (!(this instanceof DB)) return new DB(config)

  if (!config.database) throw new Error('config.database undefined')

  if (config.database.mongo) config.database = config.database.mongo
  this.config = config.database
  this.db = monk(this.config, { debug: debug })
}

DB.prototype.file = async function (filename, mode, options) {
  options = underscore.extend(options || {}, { safe: true })

  if (mode !== 'r') return (await new GridStore(this.db._db, filename, mode, options).open())

  return new Promise((resolve, reject) => {
    GridStore.exist(this.db._db, filename, (err, result) => {
      var gridStore

      if (err) return reject(err)

      if (!result) return resolve(null)

      gridStore = new GridStore(this.db._db, filename, mode, options)
      gridStore.open((err, result) => {
        if (err) return reject(err)

        resolve(result)
      })
    })
  })
}

DB.prototype.source = function (options) {
  return GridStream(this.db._db, mongodb).createReadStream(options)
}

DB.prototype.get = function (collection, debug) {
  var sdebug = new (require('sdebug'))('monk:queries')

  sdebug.initial = debug.initial

  return this.db.get(collection, { cache: false, debug: sdebug })
}

DB.prototype.checkIndices = async function (debug, entries) {
  entries.forEach(async function (entry) {
    var doneP, indices
    var category = entry.category

    try { indices = await category.indexes() } catch (ex) { indices = [] }
    doneP = underscore.intersection(underscore.keys(indices), [entry.property + '_0', entry.property + '_1']).length !== 0

    debug(entry.name + ' indices ' + (doneP ? 'already' : 'being') + ' created')
    if (doneP) return

    try {
      if (indices.length === 0) { await category.insert(entry.empty) }

      (entry.unique || []).forEach(async function (index) {
        await category.index(index, { unique: true })
      });

      (entry.others || []).forEach(async function (index) {
        await category.index(index, { unique: false })
      });

      (entry.raw || []).forEach(async function (index) {
        await category.index(index)
      })
    } catch (ex) {
      debug('unable to create ' + entry.name + ' ' + entry.property + ' index', ex)
    }
  })
}

module.exports = DB
