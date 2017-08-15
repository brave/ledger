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
{ handler: (runtime) => {
  return async (request, reply) => {
    var balances, paymentId, state, wallet
    var debug = braveHapi.debug(module, request)
    var address = request.params.address
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ address: address })
    if (!wallet) return reply(boom.notFound('invalid address: ' + address))

    paymentId = wallet.paymentId
    balances = wallet.balances
    if (!balances) {
      balances = await runtime.wallet.balances(wallet)

      state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: { balances: balances } }
      await wallets.update({ paymentId: paymentId }, state, { upsert: true })

      await runtime.queue.send(debug, 'wallet-report', underscore.extend({ paymentId: paymentId }, state.$set))
    }

    reply({
      paymentId: paymentId,
      satoshis: balances.confirmed > balances.unconfirmed ? balances.confirmed : balances.unconfirmed
    })
  }
},

  auth: {
    strategy: 'session',
    scope: [ 'ledger', 'QA' ],
    mode: 'required'
  },

  description: 'Determines the validity of a BTC address',
  tags: [ 'api' ],

  validate: {
    params: { address: braveJoi.string().base58().required().description('BTC address') }
  },

  response: {
    schema: Joi.object().keys({
      paymentId: Joi.string().guid().required().description('identity of the wallet'),
      satoshis: Joi.number().integer().min(0).optional().description('the wallet balance in satoshis')
    })
  }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/address/{address}/validate').whitelist().config(v1.validate)
]

module.exports.initialize = async (debug, runtime) => {
  runtime.db.checkIndices(debug, [
    {
      category: runtime.db.get('wallets', debug),
      name: 'wallets',
      property: 'paymentId',
      empty: {
        paymentId: '',
        address: '',
        provider: '',
        balances: {},
        paymentStamp: 0,
        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { paymentId: 1 }, { address: 1 } ],
      others: [ { provider: 1 }, { paymentStamp: 1 }, { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('wallet-report')
}

/* END: EXPERIMENTAL/DEPRECATED */
