#!/bin/bash

# Script de deploy para cuanto-aumento-node
# Uso: ./deploy.sh [comando]

set -e

COLOR_GREEN='\033[0;32m'
COLOR_BLUE='\033[0;34m'
COLOR_RED='\033[0;31m'
COLOR_YELLOW='\033[1;33m'
COLOR_RESET='\033[0m'

function print_info() {
    echo -e "${COLOR_BLUE}ℹ ${1}${COLOR_RESET}"
}

function print_success() {
    echo -e "${COLOR_GREEN}✓ ${1}${COLOR_RESET}"
}

function print_error() {
    echo -e "${COLOR_RED}✗ ${1}${COLOR_RESET}"
}

function print_warning() {
    echo -e "${COLOR_YELLOW}⚠ ${1}${COLOR_RESET}"
}

function check_requirements() {
    print_info "Verificando requisitos..."

    if ! command -v docker &> /dev/null; then
        print_error "Docker no está instalado"
        exit 1
    fi

    if ! command -v docker-compose &> /dev/null; then
        print_error "Docker Compose no está instalado"
        exit 1
    fi

    if [ ! -f .env ]; then
        print_warning ".env no encontrado, copiando desde .env.production"
        cp .env.production .env
        print_warning "IMPORTANTE: Edita el archivo .env con tus variables"
        exit 1
    fi

    print_success "Requisitos verificados"
}

function create_database() {
    print_info "Creando base de datos cuanto_aumento..."

    # Leer credenciales del .env
    source .env

    # Extraer usuario y password del DATABASE_URL
    DB_USER=$(echo $DATABASE_URL | sed -n 's/.*:\/\/\([^:]*\):.*/\1/p')
    DB_PASS=$(echo $DATABASE_URL | sed -n 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/p')

    docker exec -i mysql mysql -u root -p${MYSQL_ROOT_PASSWORD:-rootpassword} <<EOF
CREATE DATABASE IF NOT EXISTS cuanto_aumento CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON cuanto_aumento.* TO '${DB_USER}'@'%';
FLUSH PRIVILEGES;
EOF

    print_success "Base de datos creada/verificada"
}

function build() {
    print_info "Construyendo imagen Docker..."
    docker-compose build
    print_success "Imagen construida exitosamente"
}

function start() {
    print_info "Iniciando servicio..."
    docker-compose up -d
    print_success "Servicio iniciado"

    sleep 3
    print_info "Verificando estado..."
    docker-compose ps
}

function stop() {
    print_info "Deteniendo servicio..."
    docker-compose down
    print_success "Servicio detenido"
}

function restart() {
    print_info "Reiniciando servicio..."
    docker-compose restart api
    print_success "Servicio reiniciado"
}

function logs() {
    docker-compose logs -f api
}

function shell() {
    print_info "Abriendo shell en el contenedor..."
    docker exec -it cuanto-aumento-scraper sh
}

function migrate() {
    print_info "Ejecutando migraciones de Prisma..."
    docker exec -it cuanto-aumento-scraper npx prisma migrate deploy
    print_success "Migraciones ejecutadas"
}

function scrape_disco() {
    print_info "Ejecutando scraper de Disco (Master)..."
    docker exec -it cuanto-aumento-scraper npm run scrape:disco
}

function scrape_all() {
    print_info "Ejecutando todos los scrapers..."
    docker exec -it cuanto-aumento-scraper npm run scrape:all
}

function status() {
    print_info "Estado del servicio:"
    docker ps | grep cuanto-aumento || print_warning "Contenedor no está corriendo"

    echo ""
    print_info "Logs recientes:"
    docker-compose logs --tail=20 api
}

function full_deploy() {
    print_info "=== INICIANDO DEPLOY COMPLETO ==="

    check_requirements
    create_database
    build
    start

    sleep 5

    print_info "Esperando que el servicio esté listo..."
    sleep 10

    print_success "=== DEPLOY COMPLETADO ==="
    print_info "Verifica los logs con: ./deploy.sh logs"
    print_info "Ejecuta scraper inicial con: ./deploy.sh scrape-disco"
}

function show_help() {
    echo "Uso: ./deploy.sh [comando]"
    echo ""
    echo "Comandos disponibles:"
    echo "  deploy          Deploy completo (build + start + migrate)"
    echo "  build           Construir imagen Docker"
    echo "  start           Iniciar servicio"
    echo "  stop            Detener servicio"
    echo "  restart         Reiniciar servicio"
    echo "  logs            Ver logs en tiempo real"
    echo "  shell           Abrir shell en el contenedor"
    echo "  migrate         Ejecutar migraciones de Prisma"
    echo "  scrape-disco    Ejecutar scraper de Disco"
    echo "  scrape-all      Ejecutar todos los scrapers"
    echo "  status          Ver estado del servicio"
    echo "  create-db       Crear base de datos MySQL"
    echo "  help            Mostrar esta ayuda"
}

# Main
case "${1}" in
    deploy)
        full_deploy
        ;;
    build)
        build
        ;;
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    logs)
        logs
        ;;
    shell)
        shell
        ;;
    migrate)
        migrate
        ;;
    scrape-disco)
        scrape_disco
        ;;
    scrape-all)
        scrape_all
        ;;
    status)
        status
        ;;
    create-db)
        create_database
        ;;
    help|--help|-h|"")
        show_help
        ;;
    *)
        print_error "Comando desconocido: ${1}"
        echo ""
        show_help
        exit 1
        ;;
esac
