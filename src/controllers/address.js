var boom = require('boom')
var braveHapi = require('../brave-hapi')
var braveJoi = require('../brave-joi')
var bson = require('bson')
var Joi = require('joi')
var underscore = require('underscore')

var v1 = {}

/*
   GET /v1/address/{address}/validate
 */

v1.validate =
{ handler: function (runtime) {
  return async function (request, reply) {
    var wallet
    var debug = braveHapi.debug(module, request)
    var address = request.params.address
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ address: address })
    if (!wallet) return reply(boom.notFound('invalid address: ' + address))

    reply({})
  }
},

  auth:
    { strategy: 'simple',
      mode: 'required'
    },

  description: 'Determines the validity of a BTC address',
  tags: [ 'api' ],

  validate:
    { params: { address: braveJoi.string().base58().required().description('BTC address') },
      query: { access_token: Joi.string().guid().optional() }
    },

  response:
    { schema: Joi.object().length(0) }
}

/*
   PUT /v1/address/{address}/validate
 */

v1.populate =
{ handler: function (runtime) {
  return async function (request, reply) {
/*
TODO: verify transaction with actor
 */

    var wallet
    var debug = braveHapi.debug(module, request)
    var address = request.params.address
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ address: address })
    if (!wallet) return reply(boom.notFound('invalid address: ' + address))

    await runtime.queue.send(debug, 'population-report',
                             underscore.extend({ paymentId: wallet.paymentId, address: address }, request.payload))
    reply({})
  }
},

  auth:
    { strategy: 'simple',
      mode: 'required'
    },

  description: 'Validates the "attempt to populate" a BTC address',
  tags: [ 'api' ],

  validate:
    { params: { address: braveJoi.string().base58().required().description('BTC address') },
      query: { access_token: Joi.string().guid().optional() },
      payload:
      { actor: Joi.string().required().description('authorization agent'),
        transactionId: Joi.string().required().description('transaction-identifier'),
        amount: Joi.number().min(5).optional().description('the payment amount in fiat currency'),
        currency: braveJoi.string().currencyCode().optional().default('USD').description('the fiat currency')
      }
    },

  response:
    { schema: Joi.object().length(0) }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/address/{address}/validate').whitelist().config(v1.validate),
  braveHapi.routes.async().put().path('/v1/address/{address}/validate').whitelist().config(v1.populate)
]

module.exports.initialize = async function (debug, runtime) {
  runtime.db.checkIndices(debug,
  [ { category: runtime.db.get('wallets', debug),
      name: 'wallets',
      property: 'paymentId',
      empty: { paymentId: '', address: '', provider: '', balances: {}, paymentStamp: 0, timestamp: bson.Timestamp.ZERO },
      unique: [ { paymentId: 0 }, { address: 0 } ],
      others: [ { provider: 1 }, { paymentStamp: 1 }, { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('population-report')
}
