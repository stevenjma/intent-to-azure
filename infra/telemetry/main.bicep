targetScope = 'resourceGroup'

@description('Stable prefix for the telemetry resources.')
param namePrefix string = 'intent-to-azure-poc'

@description('Azure region for Log Analytics and Application Insights.')
param location string = resourceGroup().location

@minValue(30)
@maxValue(730)
@description('Telemetry retention in days.')
param retentionInDays int = 30

@minValue(1)
@maxValue(1)
@description('Maximum daily Log Analytics ingestion in GB for the POC.')
param dailyQuotaGb int = 1

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${namePrefix}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    IngestionMode: 'LogAnalytics'
    WorkspaceResourceId: workspace.id
    DisableIpMasking: false
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output applicationInsightsName string = applicationInsights.name
output connectionString string = applicationInsights.properties.ConnectionString
output workspaceId string = workspace.id
