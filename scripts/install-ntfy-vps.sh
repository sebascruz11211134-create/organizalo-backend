#!/bin/bash
# install-ntfy-vps.sh — Instala ntfy en el VPS con Docker + nginx
# Correr como root en el VPS: bash install-ntfy-vps.sh
#
# Resultado: ntfy disponible en https://ntfy.organizalo.ai

set -e

DOMAIN="ntfy.organizalo.ai"
NTFY_DATA="/opt/ntfy"

echo "═══════════════════════════════════════════════"
echo "  Instalando ntfy para Organízalo.AI"
echo "  Dominio: $DOMAIN"
echo "═══════════════════════════════════════════════"

# ── Instalar Docker si no está ────────────────────────────────────────────────
if ! command -v docker &> /dev/null; then
  echo "Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# ── Crear directorios ─────────────────────────────────────────────────────────
mkdir -p $NTFY_DATA/cache $NTFY_DATA/data

# ── Configuración de ntfy ─────────────────────────────────────────────────────
cat > $NTFY_DATA/server.yml <<EOF
# ntfy server configuration
base-url: https://$DOMAIN
cache-file: /var/cache/ntfy/cache.db
auth-file: /var/lib/ntfy/auth.db
auth-default-access: deny-all
behind-proxy: true
log-level: warn
EOF

echo "✓ Configuración creada"

# ── Iniciar contenedor ntfy ───────────────────────────────────────────────────
docker rm -f ntfy 2>/dev/null || true

docker run -d \
  --name ntfy \
  --restart unless-stopped \
  -p 127.0.0.1:8080:80 \
  -v $NTFY_DATA/cache:/var/cache/ntfy \
  -v $NTFY_DATA/data:/var/lib/ntfy \
  -v $NTFY_DATA/server.yml:/etc/ntfy/server.yml:ro \
  binwiederhier/ntfy serve

echo "✓ Contenedor ntfy iniciado"

# ── Nginx reverse proxy ───────────────────────────────────────────────────────
cat > /etc/nginx/sites-available/ntfy <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

ln -sf /etc/nginx/sites-available/ntfy /etc/nginx/sites-enabled/ntfy
nginx -t && systemctl reload nginx
echo "✓ Nginx configurado"

# ── SSL con certbot ───────────────────────────────────────────────────────────
if command -v certbot &> /dev/null; then
  certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m admin@organizalo.ai
  echo "✓ SSL configurado"
fi

# ── Crear token de admin para Organízalo ─────────────────────────────────────
# El backend usa este token para publicar notificaciones
ADMIN_TOKEN=$(openssl rand -hex 32)
docker exec ntfy ntfy token add --role=admin organizalo-admin

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ ntfy instalado correctamente"
echo ""
echo "  URL: https://$DOMAIN"
echo ""
echo "  Agregar al .env del backend:"
echo "  NTFY_URL=https://$DOMAIN"
echo "  NTFY_AUTH_TOKEN=<token generado arriba>"
echo "═══════════════════════════════════════════════"
