# Deploy Rápido - Cuanto Aumento Node API

## 🚀 Comandos Esenciales

### **Deploy en 5 pasos:**

```bash
# 1. Clonar el proyecto en el VPS
git clone https://github.com/tu-usuario/cuanto-aumento-node.git
cd cuanto-aumento-node

# 2. Configurar variables de entorno
cp .env.production .env
nano .env  # Editar con tus valores

# 3. Dar permisos al script de deploy
chmod +x deploy.sh

# 4. Crear la base de datos
./deploy.sh create-db

# 5. Deploy completo
./deploy.sh deploy
```

---

## ⚙️ Variables de Entorno Mínimas

Edita el archivo `.env` con estos valores **OBLIGATORIOS**:

```bash
# Puerto
PORT=3001

# Base de datos (usar el MySQL existente)
DATABASE_URL=mysql://ahorrapp_user:Dwu266-C+Av5gWA@mysql:3306/cuanto_aumento

# VTEX (extraer según COMO_OBTENER_HASH.md)
VTEX_SHA256_HASH=TU_HASH_AQUI

# Redis (crear en https://console.upstash.com/)
UPSTASH_REDIS_REST_URL=https://tu-instancia.upstash.io
UPSTASH_REDIS_REST_TOKEN=AaBb...

# Token de API (generar con: openssl rand -hex 32)
API_TOKEN=TU_TOKEN_SECRETO_AQUI
```

---

## 📝 Comandos del Script Helper

```bash
./deploy.sh deploy        # Deploy completo
./deploy.sh start          # Iniciar servicio
./deploy.sh stop           # Detener servicio
./deploy.sh restart        # Reiniciar servicio
./deploy.sh logs           # Ver logs en tiempo real
./deploy.sh status         # Ver estado del contenedor
./deploy.sh shell          # Abrir shell en el contenedor
./deploy.sh scrape-disco   # Ejecutar scraper de Disco (Master)
./deploy.sh scrape-all     # Ejecutar todos los scrapers
```

---

## 🔍 Verificar que Funciona

```bash
# Ver logs
./deploy.sh logs

# Probar API
curl http://localhost:3001/api/products

# Ver estado del contenedor
docker ps | grep cuanto-aumento
```

---

## 🐛 Solución de Problemas Comunes

### Error: "Cannot connect to database"
```bash
# Verificar que MySQL está corriendo
docker ps | grep mysql

# Verificar que la base de datos existe
docker exec -it mysql mysql -u ahorrapp_user -p
# Luego: SHOW DATABASES;
```

### Error: "Network bridge-communication not found"
```bash
# Crear la red
docker network create bridge-communication

# Reiniciar
./deploy.sh restart
```

### Actualizar el hash de VTEX
```bash
# Seguir instrucciones en COMO_OBTENER_HASH.md
# Luego editar .env
nano .env

# Reiniciar servicio
./deploy.sh restart
```

---

## 📚 Documentación Completa

Ver `DEPLOY.md` para la guía completa con todos los detalles.
