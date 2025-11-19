#!/bin/bash

# Script para verificar las variables de entorno en Cloud Run
SERVICE_NAME="estateadmin-backend"
REGION="us-central1"

echo "🔍 Verificando variables de entorno en Cloud Run..."
echo "📦 Servicio: $SERVICE_NAME"
echo "🌎 Región: $REGION"
echo ""

# Obtener las variables de entorno
echo "📋 Variables de entorno configuradas:"
echo ""

gcloud run services describe $SERVICE_NAME \
  --region=$REGION \
  --format="value(spec.template.spec.containers[0].env)" 2>/dev/null

if [ $? -ne 0 ]; then
  echo "❌ Error al obtener información del servicio"
  echo ""
  echo "Verifica que:"
  echo "1. Estés autenticado: gcloud auth login"
  echo "2. El nombre del servicio sea correcto: $SERVICE_NAME"
  echo "3. La región sea correcta: $REGION"
  echo ""
  echo "Para listar todos los servicios:"
  echo "gcloud run services list"
  exit 1
fi

echo ""
echo "✅ Variables obtenidas exitosamente"
echo ""
echo "⚠️  Variables críticas a verificar:"
echo "   - FIREBASE_PROJECT_ID"
echo "   - FIREBASE_PRIVATE_KEY"
echo "   - FIREBASE_CLIENT_EMAIL"
echo "   - WHATSAPP_ACCESS_TOKEN"
echo "   - PORT (debe ser 8080)"
