module.exports =
{ port                  : process.env.PORT || 3001
, database              :
  { mongo               : process.env.MONGODB_URI || 'localhost/test' }
, queue                 :
  { rsmq                : process.env.REDIS_URL || 'localhost:6379' }
, wallet                :
  { bitgo               :
    { accessToken       : process.env.BITGO_TOKEN || '...'
    , enterpriseId      : process.env.BITGO_ENTERPRISE_ID || '...'
    , environment       : process.env.BITGO_ENVIRONMENT || '...'
    , settlementAddress : process.env.BITGO_ESCROW_ADDRESS || '...'
    , unspendableXpub   : process.env.BITGO_UNSPENDABLE_XPUB || '...'
    }
  , coinbase            :
    { widgetCode        : process.env.COINBASE_WIDGET_CODE || '...' }
  }
, login                 :
  { organization        : '...'
  , world               : '/documentation'
  , bye                 : 'https://example.com'
  , clientId            : process.env.GITHUB_CLIENT_ID
  , clientSecret        : process.env.GITHUB_CLIENT_SECRET
  , ironKey             : process.env.IRON_KEYPASS
  , isSecure            : process.env.GITHUB_FORCE_HTTPS || false
  }
}
