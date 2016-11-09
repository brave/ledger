var boom = require('boom')
var braveHapi = require('../brave-hapi')
var braveJoi = require('../brave-joi')
var bson = require('bson')
var Joi = require('joi')
var stripe
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

// currently hard-coded to stripe

var retrieveCharge = async function (actor, chargeId) {
  return new Promise((resolve, reject) => {
    if (actor !== 'authorize.stripe') reject(new Error('invalid result.actor'))

    stripe.charges.retrieve(chargeId, (err, charge) => {
      if (err) return reject(err)

      charge.amount = (charge.amount / 100).toFixed(2)
      charge.currency = charge.currency.toUpperCase()
      resolve(charge)
    })
  })
}

v1.populate =
{ handler: function (runtime) {
  return async function (request, reply) {
    var result, satoshis, wallet
    var debug = braveHapi.debug(module, request)
    var address = request.params.address
    var actor = request.payload.actor
    var amount = request.payload.amount
    var currency = request.payload.currency
    var fee = request.payload.fee
    var transactionId = request.payload.transactionId
    var rate = runtime.wallet.rates[currency.toUpperCase()]
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ address: address })
    if (!wallet) return reply(boom.notFound('invalid address: ' + address))

    try { result = await retrieveCharge(actor, transactionId) } catch (ex) { reply(boom.badData(ex.toString())) }
    debug('populate', result)
    if ((result.amount !== amount.toString()) || (result.currency !== currency)) {
      return reply(boom.badData('amount/currency mismatch'))
    }
    if (amount <= fee) return reply(boom.badData('amount/fee mismatch'))

    await runtime.queue.send(debug, 'population-report',
                             underscore.extend({ paymentId: wallet.paymentId, address: address, satoshis: satoshis },
                             request.payload))
    reply({ satoshis: satoshis })
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
        fee: Joi.number().min(0).required().description('the processing fee in fiat currency'),
        amount: Joi.number().min(5).required().description('the payment amount in fiat currency'),
        currency: braveJoi.string().currencyCode().required().default('USD').description('the fiat currency')
      }
    },

  response:
    { schema: { satoshis: Joi.number().integer().min(0).optional().description('the populated amount in satoshis') } }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/address/{address}/validate').whitelist().config(v1.validate),
  braveHapi.routes.async().put().path('/v1/address/{address}/validate').whitelist().config(v1.populate)
]

module.exports.initialize = async function (debug, runtime) {
  stripe = require('stripe')(runtime.config.payments.stripe.secretKey)

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
