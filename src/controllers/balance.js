var braveHapi = require('../brave-hapi')
var bson = require('bson')
var Joi = require('joi')
var ledgerBalance = require('ledger-balance')
var underscore = require('underscore')

var v1 = {}

var rulesetId = 2

var rulesetEntry = async function (request, runtime) {
  var entry
  var debug = braveHapi.debug(module, request)
  var version = runtime.npminfo.children['ledger-balance']
  var rulesets = runtime.db.get('rulesets', debug)

  entry = await rulesets.findOne({ rulesetId: rulesetId })
  if ((!entry) || (entry.version.indexOf(version) !== 0)) {
    if (entry) rulesets.remove({ rulesetId: rulesetId })

    entry = { ruleset: ledgerBalance.providers, version: version }
  }

  return entry
}

/*
   GET /v1/balance/providers
 */

v1.read =
{ handler: function (runtime) {
  return async function (request, reply) {
    var entry = await rulesetEntry(request, runtime)

    reply(entry.ruleset)
  }
},

  description: 'Returns the list of ledger balance providers',
  tags: [ 'api' ],

  validate:
    { query: {} },

  response:
    { schema: ledgerBalance.schema }
}

/*
   POST /v1/balance/providers
 */

v1.create =
{ handler: function (runtime) {
  return async function (request, reply) {
    var state
    var debug = braveHapi.debug(module, request)
    var version = runtime.npminfo.children['ledger-balance'] + '-' + underscore.now()
    var rulesets = runtime.db.get('rulesets', debug)

    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { ruleset: request.payload, version: version, type: 'balance/providers' }
            }
    await rulesets.update({ rulesetId: rulesetId }, state, { upsert: true })

    reply(version)
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'ledger' ],
      mode: 'required'
    },

  description: 'Defines the list of ledger balance providers',
  tags: [ 'api' ],

  validate:
    { payload: ledgerBalance.schema },

  response:
    { schema: Joi.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+-[1-9][0-9]+$/) }
}

/*
   DELETE /v1/balance/providers
 */

v1.delete =
{ handler: function (runtime) {
  return async function (request, reply) {
    var debug = braveHapi.debug(module, request)
    var rulesets = runtime.db.get('rulesets', debug)

    await rulesets.remove({ rulesetId: rulesetId })

    reply(runtime.npminfo.children['ledger-balance'])
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'ledger' ],
      mode: 'required'
    },

  description: 'Resets the list of ledger balance providers',
  tags: [ 'api' ],

  validate:
    { query: {} },

  response:
    { schema: Joi.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/) }
}

/*
   GET /v1/balance/providers/version
 */

v1.version =
{ handler: function (runtime) {
  return async function (request, reply) {
    var entry = await rulesetEntry(request, runtime)

    reply(entry.version)
  }
},

  description: 'Returns the version of the ledger balance providers list',
  tags: [ 'api' ],

  validate:
    { query: {} },

  response:
    { schema: Joi.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[1-9]+[0-9]*)?$/) }
}

module.exports.routes = [
  braveHapi.routes.async().get().path('/v1/balance/providers').config(v1.read),
  braveHapi.routes.async().post().path('/v1/balance/providers').config(v1.create),
  braveHapi.routes.async().delete().path('/v1/balance/providers').config(v1.delete),
  braveHapi.routes.async().get().path('/v1/balance/providers/version').config(v1.version)
]

module.exports.initialize = async function (debug, runtime) {
  var entry, validity
  var rulesets = runtime.db.get('rulesets', debug)

  runtime.db.checkIndices(debug,
  [ { category: rulesets,
      name: 'rulesets',
      property: 'rulesetId',
      empty: { rulesetId: 0, type: '', version: '', timestamp: bson.Timestamp.ZERO },
      unique: [ { rulesetId: 1 } ],
      others: [ { type: 1 }, { version: 1 }, { timestamp: 1 } ]
    }
  ])

  entry = await rulesets.findOne({ rulesetId: rulesetId })
  validity = Joi.validate(entry ? entry.ruleset : ledgerBalance.providers, ledgerBalance.schema)
  if (validity.error) throw new Error(validity.error)
}
