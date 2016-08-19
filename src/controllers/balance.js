var braveHapi = require('../brave-hapi')
var bson = require('bson')
var Joi = require('joi')
var ledgerBalance = require('ledger-balance')

var v1 = {}

var rulesetId = 2

/*
   GET /v1/balance/providers
 */

v1.read =
{ handler: function (runtime) {
  return async function (request, reply) {
    reply(ledgerBalance.providers)
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
    var rulesets = runtime.db.get('rulesets', debug)

    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { rules: request.payload, type: 'balance/providers' }
            }
    await rulesets.update({ rulesetId: rulesetId }, state, { upsert: true })
    ledgerBalance.providers = request.payload

    reply({})
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
    { schema: Joi.any() }
}

module.exports.routes = [
  braveHapi.routes.async().get().path('/v1/balance/providers').config(v1.read),
  braveHapi.routes.async().post().path('/v1/balance/providers').config(v1.create)
]

module.exports.initialize = async function (debug, runtime) {
  var entry, validity
  var rulesets = runtime.db.get('rulesets', debug)

  runtime.db.checkIndices(debug,
  [ { category: rulesets,
      name: 'rulesets',
      property: 'rulesetId',
      empty: { rulesetId: 0, type: '', timestamp: bson.Timestamp.ZERO },
      unique: [ { rulesetId: 1 } ],
      others: [ { type: 1 }, { timestamp: 1 } ]
    }
  ])

  entry = await rulesets.findOne({ rulesetId: rulesetId })
  if (entry) ledgerBalance.providers = entry.rules
  validity = Joi.validate(ledgerBalance.providers, ledgerBalance.schema)
  if (validity.error) throw new Error(validity.error)
}
