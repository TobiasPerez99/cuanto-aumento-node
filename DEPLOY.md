# Guía de Deploy con Docker en VPS

## 📋 Pre-requisitos

1. VPS con Docker y Docker Compose instalados
2. Acceso SSH al VPS
3. MySQL ya corriendo en Docker (según tu configuración existente)
4. Cuenta de Upstash Redis (https://console.upstash.com/)

---

## 🔧 Variables de Entorno Requeridas

### **OBLIGATORIAS** ✅

```bash
# Puerto de la API
PORT=3001

# Base de datos (conectar al MySQL existente)
DATABASE_URL=mysql://ahorrapp_user:Dwu266-C+Av5gWA@mysql:3306/cuanto_aumento

# Hash VTEX para scraping
VTEX_SHA256_HASH=tu_hash_aqui

# Redis (Upstash)
UPSTASH_REDIS_REST_URL=https://tu-instancia.upstash.io
UPSTASH_REDIS_REST_TOKEN=tu_token_aqui

# Token de autenticación para endpoints de scrapers
API_TOKEN=tu_token_secreto_aqui
```

### **OPCIONALES** 📌

```bash
# EANs específicos para scraping
PRODUCT_EANS=["7790742028433","7790387003130"]

# Webhooks
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
WEBHOOK_URL=https://tu-webhook.com/endpoint

# Configuración de jobs
JOB_RETENTION_HOURS=24
```

---

## 🚀 Pasos para Deploy

### 1️⃣ **Preparar el Servidor**

```bash
# Conectar al VPS
ssh usuario@tu-vps-ip

# Crear directorio del proyecto
mkdir -p /opt/cuanto-aumento-node
cd /opt/cuanto-aumento-node
```

### 2️⃣ **Subir el Código**

Opción A - Usando Git (recomendado):
```bash
# Clonar el repositorio
git clone https://github.com/tu-usuario/cuanto-aumento-node.git .

# O si ya existe, actualizar
git pull origin main
```

Opción B - Usando SCP desde tu máquina local:
```bash
# Desde tu máquina local
scp -r C:\laragon\www\cuanto-aumento-node/* usuario@tu-vps-ip:/opt/cuanto-aumento-node/
```

### 3️⃣ **Configurar Variables de Entorno**

```bash
# Copiar template y editar
cp .env.production .env
nano .env
```

**Configurar estas variables:**

1. **Generar API_TOKEN:**
   ```bash
   openssl rand -hex 32
   ```

2. **Obtener VTEX_SHA256_HASH:**
   - Seguir instrucciones en `COMO_OBTENER_HASH.md`
   - O ejecutar: `node scripts/extractVtexHash.js`

3. **Configurar Upstash Redis:**
   - Ir a https://console.upstash.com/
   - Crear una base de datos Redis
   - Copiar REST URL y REST TOKEN

4. **DATABASE_URL:**
   ```bash
   # IMPORTANTE: Primero crear la base de datos en MySQL
   mysql -h 127.0.0.1 -u ahorrapp_user -p
   CREATE DATABASE cuanto_aumento CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   EXIT;

   # Luego configurar en .env
   DATABASE_URL=mysql://ahorrapp_user:Dwu266-C+Av5gWA@mysql:3306/cuanto_aumento
   ```

### 4️⃣ **Crear la Base de Datos**

```bash
# Conectar al contenedor MySQL existente
docker exec -it mysql mysql -u ahorrapp_user -p

# Dentro de MySQL, ejecutar:
CREATE DATABASE cuanto_aumento CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
SHOW DATABASES;
EXIT;
```

### 5️⃣ **Construir y Levantar el Contenedor**

```bash
# Construir la imagen
docker-compose build

# Levantar el servicio
docker-compose up -d

# Ver logs
docker-compose logs -f api
```

### 6️⃣ **Verificar que Todo Funciona**

```bash
# Ver estado del contenedor
docker ps | grep cuanto-aumento

# Ver logs
docker logs -f cuanto-aumento-scraper

# Verificar conexión a la API
curl http://localhost:3001/api/products

# Verificar que las migraciones se ejecutaron
docker exec -it cuanto-aumento-scraper npx prisma migrate status
```

---

## 🔄 Actualizar el Proyecto

```bash
# Detener el contenedor
docker-compose down

# Actualizar código
git pull origin main

# Reconstruir imagen
docker-compose build

# Levantar nuevamente
docker-compose up -d

# Ver logs
docker-compose logs -f api
```

---

## 🧪 Ejecutar Scrapers

### Vía API (requiere API_TOKEN):

```bash
# Ejecutar scraper de Disco (Master)
curl -X POST http://localhost:3001/api/scrape/disco \
  -H "Authorization: Bearer TU_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "categories"}'

# Ejecutar todos los scrapers
curl -X POST http://localhost:3001/api/scrape/all \
  -H "Authorization: Bearer TU_API_TOKEN"

# Ver estado de un job
curl http://localhost:3001/api/scrape/status/job-uuid \
  -H "Authorization: Bearer TU_API_TOKEN"
```

### Dentro del Contenedor:

```bash
# Entrar al contenedor
docker exec -it cuanto-aumento-scraper sh

# Ejecutar scraper manualmente
npm run scrape:disco

# Ejecutar todos
npm run scrape:all

# Salir
exit
```

---

## 🐛 Troubleshooting

### El contenedor no inicia

```bash
# Ver logs completos
docker-compose logs api

# Ver estado
docker ps -a | grep cuanto-aumento
```

### Error de conexión a MySQL

```bash
# Verificar que MySQL está corriendo
docker ps | grep mysql

# Verificar que la red bridge-communication existe
docker network ls | grep bridge-communication

# Verificar que el contenedor está en la red correcta
docker inspect cuanto-aumento-scraper | grep -A 10 Networks
```

### Error "VTEX Hash expired"

```bash
# Extraer nuevo hash (ver COMO_OBTENER_HASH.md)
# Luego actualizar .env y reiniciar
nano .env
docker-compose restart api
```

### Las migraciones de Prisma fallan

```bash
# Ejecutar migraciones manualmente
docker exec -it cuanto-aumento-scraper npx prisma migrate deploy

# O generar cliente Prisma
docker exec -it cuanto-aumento-scraper npx prisma generate
```

---

## 📊 Comandos Útiles

```bash
# Ver logs en tiempo real
docker-compose logs -f api

# Reiniciar servicio
docker-compose restart api

# Detener servicio
docker-compose down

# Eliminar contenedor y volúmenes
docker-compose down -v

# Ver recursos usados
docker stats cuanto-aumento-scraper

# Ejecutar comando dentro del contenedor
docker exec -it cuanto-aumento-scraper npm run scrape:disco

# Abrir shell en el contenedor
docker exec -it cuanto-aumento-scraper sh

# Ver Prisma Studio (para ver la DB)
docker exec -it cuanto-aumento-scraper npx prisma studio
```

---

## 🔒 Configurar Nginx Reverse Proxy (Opcional)

Si quieres exponer la API en un dominio:

```nginx
# /etc/nginx/sites-available/cuanto-aumento-api
server {
    listen 80;
    server_name api.tudominio.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Activar:
```bash
sudo ln -s /etc/nginx/sites-available/cuanto-aumento-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Configurar SSL con Certbot:
```bash
sudo certbot --nginx -d api.tudominio.com
```

---

## 📝 Checklist Final

- [ ] MySQL corriendo con base de datos `cuanto_aumento` creada
- [ ] `.env` configurado con todas las variables obligatorias
- [ ] `API_TOKEN` generado y guardado de forma segura
- [ ] `VTEX_SHA256_HASH` extraído y configurado
- [ ] Upstash Redis creado y configurado
- [ ] Contenedor levantado con `docker-compose up -d`
- [ ] Logs verificados sin errores
- [ ] API respondiendo en `http://localhost:3001/api/products`
- [ ] Migraciones de Prisma ejecutadas correctamente
- [ ] Primer scraper ejecutado (Disco como Master)

---

## 🆘 Soporte

Si encuentras problemas:
1. Revisar logs: `docker-compose logs -f api`
2. Verificar variables de entorno: `docker exec -it cuanto-aumento-scraper env`
3. Revisar CLAUDE.md para más información del proyecto
4. Verificar COMO_OBTENER_HASH.md si hay problemas con VTEX
