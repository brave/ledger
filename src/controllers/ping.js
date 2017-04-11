var braveHapi = require('../brave-hapi')
var Joi = require('joi')

var v1 = {}

/*
   GET /v1/ping
 */

v1.ping = {
  handler: function (runtime) {
    return async function (request, reply) {
      reply(runtime.npminfo)
    }
  },

  auth: {
    strategy: 'session',
    scope: [ 'devops' ],
    mode: 'required'
  },

  description: 'Returns information about the server',
  tags: [ 'api' ],

  validate:
    { query: {} },

  response:
    { schema: Joi.object().keys().unknown(true).description('static properties of the server') }
}

module.exports.routes = [ braveHapi.routes.async().path('/v1/ping').config(v1.ping) ]
