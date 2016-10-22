var monk = require('monk')
var debug = new (require('sdebug'))('database')
var underscore = require('underscore')

var DB = function (config) {
  if (!(this instanceof DB)) return new DB(config)

  if (!config.database) throw new Error('config.database undefined')

  if (config.database.mongo) config.database = config.database.mongo
  this.db = monk(config.database, { debug: debug })
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
