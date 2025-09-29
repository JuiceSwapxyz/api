# Azure Deployment Guide für JuiceSwap API

**Datum:** September 29, 2025
**Platform:** Microsoft Azure

## Azure-spezifische Konfiguration

### 1. Environment Variables für Azure

```env
# Azure Storage für DynamoDB-Ersatz
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=<account>;AccountKey=<key>
AZURE_STORAGE_TABLE_NAME=juiceswap-routes

# Azure Redis Cache für Quote Cache
AZURE_REDIS_CONNECTION_STRING=<redis-hostname>.redis.cache.windows.net:6380,password=<key>,ssl=True

# RPC Endpoints
ALCHEMY_1=https://eth-mainnet.alchemyapi.io/v2/<your-key>
ALCHEMY_10=https://opt-mainnet.g.alchemy.com/v2/<your-key>
ALCHEMY_137=https://polygon-mainnet.g.alchemy.com/v2/<your-key>
ALCHEMY_8453=https://base-mainnet.g.alchemy.com/v2/<your-key>
ALCHEMY_42161=https://arb-mainnet.g.alchemy.com/v2/<your-key>
ALCHEMY_5115=<citrea-testnet-rpc-url>

# Azure App Service
PORT=80
NODE_ENV=production

# Monitoring
AZURE_APPLICATION_INSIGHTS_CONNECTION_STRING=<insights-connection-string>
```

### 2. Azure Services Empfehlungen

#### App Service Plan
- **SKU:** Standard S2 oder Premium P1V2
- **Instances:** Minimum 2 für Load Balancing
- **Auto-scaling:** Aktiviert (CPU > 70%)

#### Azure Cache for Redis
- **Tier:** Standard C1 (1GB) für Development, Premium P1 (6GB) für Production
- **Features:** Data persistence, Geo-replication für Multi-Region

#### Azure Table Storage
- **Alternative zu DynamoDB:** Für Route Caching
- **Performance:** Standard tier ausreichend
- **Backup:** Geo-redundant storage (GRS)

#### Application Insights
- **Monitoring:** Performance, Errors, Custom Metrics
- **Alerts:** Response time, Error rate, Availability

### 3. Azure-spezifische Optimierungen

#### Connection Pooling für Azure
```typescript
// Azure-optimierte RPC Pool Konfiguration
export const azureRpcPool = new RpcConnectionPool({
  maxConnectionsPerProvider: 8, // Azure App Service Limit
  connectionTTL: 5 * 60 * 1000, // 5 Minuten
  maxRequestsPerConnection: 100,
  cleanupInterval: 2 * 60 * 1000 // 2 Minuten (häufiger auf Azure)
});
```

#### Rate Limiting für Azure Load Balancer
```typescript
// Azure-optimierte Rate Limiting
export const azureRateLimiter = new RateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 3000, // Höher für Azure Load Balancer
  maxRequestsPerIP: 300,
  skipSuccessfulRequests: true,
  campaignMode: true
});
```

### 4. Azure Deployment Konfiguration

#### Azure App Service Configuration
```json
{
  "name": "juiceswap-api",
  "location": "West Europe",
  "sku": {
    "name": "S2",
    "tier": "Standard"
  },
  "properties": {
    "serverFarmId": "/subscriptions/{subscription-id}/resourceGroups/{rg}/providers/Microsoft.Web/serverfarms/{plan}",
    "httpsOnly": true,
    "clientAffinityEnabled": false,
    "siteConfig": {
      "nodeVersion": "18-lts",
      "alwaysOn": true,
      "webSocketsEnabled": false,
      "use32BitWorkerProcess": false,
      "ftpsState": "Disabled"
    }
  }
}
```

#### Health Check Endpoint
```typescript
// Azure-kompatible Health Checks
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    azure: {
      region: process.env.WEBSITE_SITE_NAME || 'unknown',
      instance: process.env.WEBSITE_INSTANCE_ID || 'unknown'
    }
  });
});
```

### 5. CI/CD Pipeline für Azure

#### GitHub Actions für Azure Deployment
```yaml
name: Deploy to Azure App Service

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3

    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'

    - name: Install dependencies
      run: npm ci

    - name: Build application
      run: npm run build

    - name: Deploy to Azure
      uses: azure/webapps-deploy@v2
      with:
        app-name: 'juiceswap-api'
        publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
        package: .
```

### 6. Monitoring auf Azure

#### Application Insights Integration
```typescript
import { TelemetryClient } from 'applicationinsights';

const appInsights = new TelemetryClient();

// Custom Events für Campaign Tracking
appInsights.trackEvent({
  name: 'CitreaCampaignRequest',
  properties: {
    taskNumber: taskId,
    responseTime: duration,
    cached: isCached
  }
});

// Performance Counters
appInsights.trackMetric({
  name: 'QuoteCacheHitRate',
  value: hitRate
});
```

#### Azure Monitor Alerts
- Response Time > 2 Sekunden
- Error Rate > 5%
- CPU Usage > 80%
- Memory Usage > 85%
- Cache Hit Rate < 60%

### 7. Skalierung für Citrea Campaign

#### Auto-scaling Rules
```json
{
  "rules": [
    {
      "metricTrigger": {
        "metricName": "CpuPercentage",
        "threshold": 70,
        "timeAggregation": "Average",
        "timeWindow": "PT5M"
      },
      "scaleAction": {
        "direction": "Increase",
        "type": "ChangeCount",
        "value": "1",
        "cooldown": "PT5M"
      }
    }
  ],
  "fixedDate": {
    "timeZone": "UTC",
    "start": "2025-10-01T00:00:00Z",
    "end": "2025-10-31T23:59:59Z"
  },
  "recurrence": {
    "frequency": "Week",
    "schedule": {
      "timeZone": "UTC",
      "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      "hours": [8, 12, 16, 20],
      "minutes": [0]
    }
  }
}
```

### 8. Kosten-Optimierung

#### Resource Tagging
```json
{
  "tags": {
    "Environment": "Production",
    "Project": "JuiceSwap",
    "Campaign": "Citrea-bApps",
    "Owner": "API-Team",
    "CostCenter": "Development"
  }
}
```

#### Scaling Schedule
- **Peak Hours (Campaign):** 2-4 Instances
- **Normal Hours:** 1-2 Instances
- **Low Traffic:** 1 Instance (minimum)

### 9. Security auf Azure

#### Key Vault Integration
```typescript
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

const credential = new DefaultAzureCredential();
const client = new SecretClient(
  'https://<vault-name>.vault.azure.net/',
  credential
);

// Sichere RPC Keys
const alchemyKey = await client.getSecret('alchemy-api-key');
```

#### Network Security
- Private Endpoints für Redis/Storage
- Application Gateway mit WAF
- NSG Rules für eingehenden Traffic
- HTTPS Only mit Azure-managed Certificates

### 10. Disaster Recovery

#### Multi-Region Setup
- **Primary:** West Europe
- **Secondary:** East US
- **Failover:** Automatisch über Azure Traffic Manager
- **Data Sync:** Geo-replication für Redis und Storage

---

## Deployment Checklist

### Pre-Deployment
- [ ] Azure Resource Group erstellt
- [ ] App Service Plan konfiguriert
- [ ] Redis Cache bereitgestellt
- [ ] Table Storage eingerichtet
- [ ] Application Insights aktiviert
- [ ] Key Vault mit Secrets konfiguriert

### Deployment
- [ ] GitHub Actions Pipeline eingerichtet
- [ ] Environment Variables gesetzt
- [ ] Health Checks funktional
- [ ] Auto-scaling konfiguriert
- [ ] Monitoring Alerts aktiviert

### Post-Deployment
- [ ] Load Test gegen Azure Endpoint
- [ ] Monitor Dashboard konfiguriert
- [ ] Backup Strategy implementiert
- [ ] Incident Response Plan erstellt

---

*Azure Deployment Guide für optimale Performance während der Citrea Campaign*