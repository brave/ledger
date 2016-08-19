var braveHapi = require('../brave-hapi')
var bson = require('bson')
var Joi = require('joi')
var uuid = require('node-uuid')

var v1 = {}

/*
    POST /callbacks/bitgo/sink (from the BitGo server)
 */

/*
    { hash     : '...'
    , type     : 'transaction'
    , walletId : '...'
    }
 */

v1.sink =
{ handler: function (runtime) {
  return async function (request, reply) {
    var state
    var debug = braveHapi.debug(module, request)
    var webhooks = runtime.db.get('webhooks', debug)

    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { provider: 'bitgo', payload: request.payload }
            }
    await webhooks.update({ webhookId: uuid.v4() }, state, { upsert: true })

    reply({})
  }
},

  description: 'Webhooks',
  tags: [ 'api' ],

  validate:
    { payload: Joi.any() },

  response:
    { schema: Joi.any() }
}

module.exports.routes = [ braveHapi.routes.async().post().path('/callbacks/bitgo/sink').config(v1.sink) ]

module.exports.initialize = async function (debug, runtime) {
  runtime.db.checkIndices(debug,
  [ { category: runtime.db.get('webhooks', debug),
      name: 'webhooks',
      property: 'webhookId',
      empty: { webhookId: '', provider: '', payload: '', timestamp: bson.Timestamp.ZERO },
      unique: [ { webhookId: 0 } ],
      others: [ { provider: 1 }, { timestamp: 1 } ]
    }
  ])
}
