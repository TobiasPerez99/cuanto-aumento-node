# Backend Node.js con Express

Backend API desarrollado con Node.js y Express.js.

## 🚀 Características

- Express.js como framework web
- Soporte para CORS
- Variables de entorno con dotenv
- Middlewares básicos configurados
- Manejo de errores
- Hot reload con nodemon (desarrollo)

## 📋 Requisitos

- Node.js (versión 16 o superior)
- npm o yarn

## ⚡ Instalación

1. Instalar dependencias:

```bash
npm install
```

2. Crear archivo `.env` (opcional):

```bash
PORT=3000
NODE_ENV=development
```

## 🔧 Scripts disponibles

- `npm start` - Ejecutar en producción
- `npm run dev` - Ejecutar en modo desarrollo (con nodemon)

## 🌐 Endpoints disponibles

- `GET /` - Mensaje de bienvenida
- `GET /health` - Health check del servidor

## 🏃‍♂️ Cómo ejecutar

### Desarrollo

```bash
npm run dev
```

### Producción

```bash
npm start
```

El servidor se ejecutará en `http://localhost:3000` (o el puerto configurado en .env)

## 📁 Estructura del proyecto

```
├── index.js        # Archivo principal del servidor
├── package.json    # Configuración y dependencias
├── .gitignore     # Archivos ignorados por Git
├── .env           # Variables de entorno (crear manualmente)
└── README.md      # Documentación
```
