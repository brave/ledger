var boom = require('boom')
var braveHapi = require('../brave-hapi')
var GitHub = require('github')
var Joi = require('joi')

var v1 = {}

/*
   GET /v1/login
 */

v1.login =
{ handler: function (runtime) {
  return async function (request, reply) {
    var debug = braveHapi.debug(module, request)
    var credentials = request.auth.credentials

    if (!request.auth.isAuthenticated) return reply(boom.forbidden())

    var gh = new GitHub({ version: '3.0.0', debug: false })
    gh.authenticate({ type: 'token', token: credentials.token })
    gh.user.getTeams({}, function (err, data) {
      if (err) return reply('Oops!')

      credentials.scope = []
      data.forEach(team => {
        if (team.organization.login === runtime.login.organization) credentials.scope.push(team.name)
      })
      if (credentials.scope.length === 0) {
        debug('failed ' + credentials.provider + ' ' + credentials.profile.email)
        return reply(boom.forbidden())
      }

      debug('login  ' + credentials.provider + ' ' + credentials.profile.email + ': ' + JSON.stringify(credentials.scope))

      request.auth.session.set(credentials)
      reply.redirect(runtime.login.world)
    })
  }
},

  auth: 'github',

  description: 'Logs the user into management operations',
  notes: 'This operation authenticates an administrative role for the server. The user is asked to authenticate their GitHub identity, and are assigned permissions based on team-membership. Operations are henceforth authenticated via an encrypted session cookie.',
  tags: [ 'api' ],

  validate:
    { query:
      { code: Joi.string().optional().description('an opaque string identifying an oauth flow'),
        state: Joi.string().optional().description('an opaque string')
      }
    }
}

/*
   GET /v1/logout
 */

v1.logout =
{ handler: function (runtime) {
  return async function (request, reply) {
    var debug = braveHapi.debug(module, request)
    var credentials = request.auth.credentials

    if (credentials) {
      debug('logout ' + credentials.provider + ' ' + credentials.profile.email + ': ' + JSON.stringify(credentials.scope))
    }

    request.auth.session.clear()
    reply.redirect(runtime.login.bye)
  }
},

  description: 'Logs the user out',
  notes: 'Used to remove the authenticating session cookie.',
  tags: [ 'api' ],

  validate:
    { query: {} }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/login').config(v1.login),
  braveHapi.routes.async().path('/v1/logout').config(v1.logout)
]
