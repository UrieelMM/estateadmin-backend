#!/bin/bash

# Script para ver los logs de Cloud Run en tiempo real
SERVICE_NAME="estateadmin-backend"
REGION="us-central1"

echo "📜 Mostrando logs de Cloud Run..."
echo "📦 Servicio: $SERVICE_NAME"
echo "🌎 Región: $REGION"
echo ""
echo "Presiona Ctrl+C para salir"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Ver logs en tiempo real con filtros para errores y startup
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE_NAME" \
  --limit=50 \
  --format="table(timestamp,severity,textPayload)" \
  --freshness=10m

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Para ver logs en tiempo real:"
echo "gcloud logging tail \"resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE_NAME\""
