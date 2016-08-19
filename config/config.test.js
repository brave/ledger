module.exports =
{ port                : process.env.PORT || 3001
, database            :
  { mongo             : process.env.MONGODB_URI || 'localhost/test' }
, queue               :
  { rsmq              : process.env.REDIS_URL || 'localhost:6379' }
, wallet              :
  { bitgo             :
    { accessToken     : 'YourAPIToken'
    , enterpriseId    : 'YourEnterpriseId'
    , environment     : 'test'
    , escrowAddress   : 'YourEscrowAddress'
    , unspendableXpub : 'YourUnspendableXpub'
    }
  , coinbase          :
    { widgetCode      : 'YourWidgetCode' }
  }
, login               :
  { organization      : '...'
  , world             : '/documentation'
  , bye               : 'https://example.com'
  , clientId          : process.env.GITHUB_CLIENT_ID || '00000000000000000000'
  , clientSecret      : process.env.GITHUB_CLIENT_SECRET || '0000000000000000000000000000000000000000'
  , ironKey           : process.env.IRON_KEYPASS
  , isSecure          : process.env.GITHUB_FORCE_HTTPS || false
  }
}
