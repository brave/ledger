module.exports =
{ port     : process.env.PORT        || 3001
, database : process.env.MONGODB_URI || 'localhost/test'
, queue    : process.env.REDIS_URL   || 'localhost:6379'
}
