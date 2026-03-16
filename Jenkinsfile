pipeline {
    agent any
    
    environment {
        // Application name and version
        APP_NAME = 'uar-web'
        APP_VERSION = "${env.BUILD_NUMBER}"
        
        // Docker image name
        IMAGE_NAME = "uar-web:${env.BUILD_NUMBER}"
        IMAGE_LATEST = "uar-web:latest"
        
        // Environment file path (configure in Jenkins credentials)
        ENV_FILE = credentials('uar-web-env-file')
    }
    
    stages {
        stage('Checkout') {
            steps {
                echo 'Checking out source code...'
                checkout scm
            }
        }
        
        stage('Setup Environment') {
            steps {
                echo 'Setting up environment variables...'
                script {
                    // Copy environment file to workspace
                    sh 'cp $ENV_FILE .env'
                }
            }
        }
        
        stage('Build Docker Image') {
            steps {
                echo 'Building Docker image...'
                script {
                    // Build the Docker image
                    sh """
                        docker build -t ${IMAGE_NAME} -t ${IMAGE_LATEST} .
                    """
                }
            }
        }
        
        stage('Stop Existing Containers') {
            steps {
                echo 'Stopping existing containers...'
                script {
                    // Stop and remove existing containers (ignore errors if they don't exist)
                    sh """
                        docker-compose down || true
                    """
                }
            }
        }
        
        stage('Deploy with Docker Compose') {
            steps {
                echo 'Deploying application with Docker Compose...'
                script {
                    // Start containers with docker-compose
                    sh """
                        docker-compose up -d
                    """
                }
            }
        }
        
        stage('Health Check') {
            steps {
                echo 'Performing health check...'
                script {
                    // Wait for application to be ready
                    sh """
                        echo 'Waiting for application to start...'
                        sleep 30
                        
                        # Check if containers are running
                        docker-compose ps
                        
                        # Basic health check (adjust URL as needed)
                        curl -f http://localhost:3002 || exit 1
                    """
                }
            }
        }
        
        stage('Cleanup Old Images') {
            steps {
                echo 'Cleaning up old Docker images...'
                script {
                    // Remove dangling images
                    sh """
                        docker image prune -f
                    """
                }
            }
        }
    }
    
    post {
        success {
            echo 'Deployment successful!'
            // Add notification here (email, Slack, etc.)
        }
        
        failure {
            echo 'Deployment failed!'
            // Rollback or notification
            script {
                sh """
                    docker-compose logs app
                """
            }
        }
        
        always {
            echo 'Cleaning up workspace...'
            cleanWs()
        }
    }
}
