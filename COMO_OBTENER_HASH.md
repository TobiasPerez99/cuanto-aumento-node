# 🔑 Cómo Obtener el Hash VTEX de Carrefour

## 📋 Pasos Simples:

### 1. **Abrir Carrefour**

- Ve a: https://www.carrefour.com.ar
- Presiona **F12** para abrir las herramientas de desarrollo

### 2. **Preparar el Network**

- Haz clic en la pestaña **"Network"** o **"Red"**
- ✅ Asegúrate de que esté grabando (botón rojo activo)

### 3. **Hacer una Búsqueda**

- En la página de Carrefour, busca: **"a"** (solo la letra "a")
- Presiona Enter y espera que aparezcan productos

### 4. **Encontrar el Request**

- En la pestaña Network, busca un request que contenga:
  - `productSuggestions` o `productquery`
  - Debería ser del tipo **XHR** o **Fetch**
  - La URL debe tener `carrefour.com.ar` y `graphql`

### 5. **Copiar la URL**

- **Clic derecho** en ese request
- Selecciona **"Copy"** → **"Copy link address"** o **"Copiar URL"**

### 6. **Extraer el Hash**

```bash
npm run extract-hash
```

- Pega la URL que copiaste
- ¡El script te dará el hash!

### 7. **Actualizar el Código**

- Abre: `scrapers/carrefour.js`
- Busca la línea 5: `const VTEX_SHA256_HASH = 'PON_AQUI_EL_HASH_EXTRAIDO';`
- Reemplaza `'PON_AQUI_EL_HASH_EXTRAIDO'` con el hash que obtuviste

## 🎯 Ejemplo de URL que buscas:

```
https://www.carrefour.com.ar/_v/segment/graphql/v1/?workspace=master&maxAge=medium&appsEtag=remove&domain=store&locale=es-AR&operationName=productSuggestions&variables=%7B%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%22EL_HASH_ESTA_ACA%22%2C%22sender%22%3A%22vtex.store-resources%400.x%22%2C%22provider%22%3A%22vtex.search-graphql%400.x%22%7D%2C%22variables%22%3A%22eyJwcm9kdWN0T3JpZ2luVnRleCI6dHJ1ZSwic2ltdWxhdGlvbkJlaGF2aW9yIjoiZGVmYXVsdCIsImhpZGVVbmF2YWlsYWJsZUl0ZW1zIjp0cnVlLCJmdWxsVGV4dCI6ImEiLCJjb3VudCI6NCwic2hpcHBpbmdPcHRpb25zIjpbXSwidmFyaWFudCI6bnVsbH0%3D%22%7D
```

## ❓ Si no encuentras el request:

1. **Refrescar la página** y buscar de nuevo
2. **Usar otro término** como "arroz" o "leche"
3. **Verificar que Network esté grabando**
4. **Buscar por "graphql"** en el filtro de Network

## ✅ Una vez que tengas el hash:

```bash
npm start
```

Luego prueba:

```bash
curl http://localhost:3000/scrape/carrefour/main
```

¡Deberías obtener ~200+ productos! 🎉
