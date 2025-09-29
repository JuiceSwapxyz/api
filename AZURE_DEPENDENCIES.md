# Azure Dependencies für JuiceSwap API

## Zusätzliche Dependencies für Azure

Für das Azure Deployment benötigen wir folgende zusätzliche npm packages:

```bash
# Azure Services
npm install @azure/data-tables          # Azure Table Storage
npm install @azure/storage-blob         # Azure Blob Storage
npm install @azure/identity            # Azure Authentication
npm install @azure/keyvault-secrets    # Azure Key Vault
npm install @azure/monitor-query       # Azure Monitor

# Redis für Azure Cache
npm install redis                      # Redis client
npm install ioredis                   # Alternative Redis client

# Application Insights
npm install applicationinsights        # Azure Application Insights

# Production Dependencies
npm install helmet                     # Security headers
npm install compression               # Response compression
npm install cors                      # CORS handling
```

## Package.json Erweiterung

Die folgenden Dependencies sollten zur `package.json` hinzugefügt werden:

```json
{
  "dependencies": {
    "@azure/data-tables": "^13.2.2",
    "@azure/storage-blob": "^12.17.0",
    "@azure/identity": "^4.0.1",
    "@azure/keyvault-secrets": "^4.7.0",
    "@azure/monitor-query": "^1.1.0",
    "redis": "^4.6.10",
    "ioredis": "^5.3.2",
    "applicationinsights": "^2.9.1",
    "helmet": "^7.1.0",
    "compression": "^1.7.4",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "@types/compression": "^1.7.5",
    "@types/cors": "^2.8.17"
  },
  "scripts": {
    "azure:deploy": "npm run build && zip -r deploy.zip dist/ package.json",
    "azure:start": "NODE_ENV=production node dist/src/server.js"
  }
}
```

## Environment Variables für Azure

```env
# Azure Storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=juiceswapapi;AccountKey=<key>;EndpointSuffix=core.windows.net
AZURE_STORAGE_TABLE_NAME=juiceswapRoutes

# Azure Redis Cache
AZURE_REDIS_CONNECTION_STRING=juiceswapapi.redis.cache.windows.net:6380,password=<key>,ssl=True

# Azure Key Vault
AZURE_KEY_VAULT_URL=https://juiceswapapi-kv.vault.azure.net/

# Application Insights
APPINSIGHTS_CONNECTION_STRING=InstrumentationKey=<key>;IngestionEndpoint=https://westeurope-5.in.applicationinsights.azure.com/;LiveEndpoint=https://westeurope.livediagnostics.monitor.azure.com/

# App Service
PORT=80
WEBSITE_NODE_DEFAULT_VERSION=18-lts
NODE_ENV=production

# RPC Providers (ersetze mit echten Keys)
ALCHEMY_1=https://eth-mainnet.alchemyapi.io/v2/<real-key>
ALCHEMY_10=https://opt-mainnet.g.alchemy.com/v2/<real-key>
ALCHEMY_137=https://polygon-mainnet.g.alchemy.com/v2/<real-key>
ALCHEMY_8453=https://base-mainnet.g.alchemy.com/v2/<real-key>
ALCHEMY_42161=https://arb-mainnet.g.alchemy.com/v2/<real-key>
ALCHEMY_5115=https://rpc.citrea.xyz

# Performance Settings
AZURE_FUNCTIONS_ENVIRONMENT=Production
```

## Web.config für Azure App Service

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <handlers>
      <add name="iisnode" path="dist/src/server.js" verb="*" modules="iisnode"/>
    </handlers>
    <rewrite>
      <rules>
        <rule name="DynamicContent">
          <match url="/*" />
          <conditions>
            <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="True"/>
          </conditions>
          <action type="Rewrite" url="dist/src/server.js"/>
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering removeServerHeader="true"/>
    </security>
    <httpProtocol>
      <customHeaders>
        <add name="X-Content-Type-Options" value="nosniff"/>
        <add name="X-Frame-Options" value="DENY"/>
        <add name="X-XSS-Protection" value="1; mode=block"/>
      </customHeaders>
    </httpProtocol>
  </system.webServer>
</configuration>
```

## Installation Commands

```bash
# Azure CLI Installation (für Deployment)
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Login zu Azure
az login

# Resource Group erstellen
az group create --name juiceswap-api-rg --location westeurope

# App Service Plan erstellen
az appservice plan create --name juiceswap-plan --resource-group juiceswap-api-rg --sku S2 --is-linux

# Web App erstellen
az webapp create --resource-group juiceswap-api-rg --plan juiceswap-plan --name juiceswap-api --runtime "NODE|18-lts"

# Redis Cache erstellen
az redis create --location westeurope --name juiceswap-cache --resource-group juiceswap-api-rg --sku Standard --vm-size C1

# Storage Account erstellen
az storage account create --name juiceswapapi --resource-group juiceswap-api-rg --location westeurope --sku Standard_LRS

# Application Insights erstellen
az monitor app-insights component create --app juiceswap-api --location westeurope --resource-group juiceswap-api-rg
```

## GitHub Actions für Azure Deployment

`.github/workflows/azure-deploy.yml`:

```yaml
name: Deploy to Azure App Service

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest

    steps:
    - uses: actions/checkout@v4

    - name: Set up Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '18'
        cache: 'npm'

    - name: Install dependencies
      run: |
        npm ci
        npm install @azure/data-tables @azure/identity applicationinsights redis helmet compression

    - name: Build application
      run: npm run build

    - name: Run tests
      run: npm test

    - name: Deploy to Azure Web App
      uses: azure/webapps-deploy@v2
      with:
        app-name: 'juiceswap-api'
        publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
        package: .

    - name: Azure CLI script
      uses: azure/CLI@v1
      with:
        azcliversion: 2.30.0
        inlineScript: |
          az webapp restart --name juiceswap-api --resource-group juiceswap-api-rg
```

## Monitoring Setup

### Application Insights Integration

```javascript
// src/monitoring/azureInsights.ts
import * as appInsights from 'applicationinsights';

if (process.env.APPINSIGHTS_CONNECTION_STRING) {
  appInsights.setup(process.env.APPINSIGHTS_CONNECTION_STRING)
    .setAutoDependencyCorrelation(true)
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true, true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectConsole(true)
    .setUseDiskRetryCaching(true)
    .setSendLiveMetrics(true)
    .start();

  console.log('[Azure] Application Insights initialized');
}

export const telemetryClient = appInsights.defaultClient;
```

### Custom Metrics für Citrea Campaign

```javascript
// Track campaign-specific metrics
telemetryClient?.trackEvent({
  name: 'CitreaCampaignQuote',
  properties: {
    taskNumber: params.taskId,
    tokenPair: `${params.tokenIn}_${params.tokenOut}`,
    amount: params.amount,
    cached: response.hitsCachedRoutes
  },
  measurements: {
    responseTime: duration,
    cacheHitRate: cacheStats.hitRate
  }
});

// Track performance
telemetryClient?.trackMetric({
  name: 'QuoteResponseTime',
  value: duration,
  properties: {
    chain: params.tokenInChainId,
    cached: response.hitsCachedRoutes
  }
});
```