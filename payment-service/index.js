require('dotenv').config();
const { Pool } = require('pg');
const amqp = require('amqplib');

// --- 1. НАСТРОЙКА И ПОДКЛЮЧЕНИЯ ---

const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

let rabbitChannel;

// --- 2. ГЛАВНАЯ ЛОГИКА - ОБРАБОТКА СОБЫТИЯ ---

// Эта функция будет вызываться для каждого полученного сообщения
async function processOrderCreatedEvent(msg) {
    if (msg === null) return;

    try {
        const eventData = JSON.parse(msg.content.toString());
        const { orderId, totalAmount } = eventData;

        console.log(`[PaymentService] Received OrderCreated event for orderId: ${orderId}, amount: ${totalAmount}`);

        // --- Шаг A: Сохраняем информацию о платеже в БД со статусом "Processing" ---
        const insertQuery = `
            INSERT INTO payments (order_id, amount, status) 
            VALUES ($1, $2, 'Processing') 
            RETURNING payment_id;
        `;
        const result = await pgPool.query(insertQuery, [orderId, totalAmount]);
        const paymentId = result.rows[0].payment_id;

        // --- Шаг B: Симулируем обращение к внешнему платежному шлюзу ---
        console.log(`[PaymentService] Processing payment ${paymentId} for order ${orderId}...`);
        // В реальном приложении здесь был бы вызов Stripe, PayPal и т.д.
        // Мы просто подождем 2 секунды для имитации.
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // --- Шаг C: Симулируем успешное завершение платежа ---
        const transactionId = `txn_${Date.now()}`;
        const updateQuery = `
            UPDATE payments 
            SET status = 'Successful', transaction_id = $1, payment_system = 'MockGateway', updated_at = NOW()
            WHERE payment_id = $2;
        `;
        await pgPool.query(updateQuery, [transactionId, paymentId]);
        console.log(`[PaymentService] Payment ${paymentId} for order ${orderId} was successful.`);

        // --- Шаг D: Публикуем новое событие "PaymentSuccessful" ---
        const paymentSuccessfulEvent = {
            orderId: orderId,
            paymentId: paymentId,
            transactionId: transactionId
        };

        // Публикуем в тот же обменник, но с другим ключом маршрутизации
        rabbitChannel.publish(
            'orders_exchange',
            'payment.successful', // Другой ключ!
            Buffer.from(JSON.stringify(paymentSuccessfulEvent))
        );
        console.log(`[PaymentService] Published PaymentSuccessful event for orderId: ${orderId}`);

        // --- Шаг E: Подтверждаем, что сообщение обработано ---
        // Это удалит сообщение из очереди RabbitMQ.
        rabbitChannel.ack(msg);

    } catch (error) {
        console.error('[PaymentService] Error processing message:', error);
        // В реальном приложении здесь была бы логика для повторной обработки "сломавшихся" сообщений.
        // Мы пока просто отклоняем его.
        rabbitChannel.nack(msg, false, false);
    }
}


// --- 3. ЗАПУСК ПОДПИСЧИКА ---

async function startConsumer() {
    try {
        const connection = await amqp.connect(process.env.RABBITMQ_URL);
        rabbitChannel = await connection.createChannel();
        
        // Убедимся, что обменник существует
        await rabbitChannel.assertExchange('orders_exchange', 'topic', { durable: true });
        
        // Создаем эксклюзивную, временную очередь для нашего сервиса
        const q = await rabbitChannel.assertQueue('payment_service_queue', { durable: true });

        console.log(`[PaymentService] Waiting for messages in queue: ${q.queue}`);

        // Связываем нашу очередь с обменником, чтобы получать сообщения
        // Мы подписываемся на события с ключом 'order.created'
        rabbitChannel.bindQueue(q.queue, 'orders_exchange', 'order.created');
        
        // Начинаем потреблять сообщения из очереди
        rabbitChannel.consume(
            q.queue,
            processOrderCreatedEvent, // Функция-обработчик
            { noAck: false } // Требуется ручное подтверждение (ack/nack)
        );

    } catch (error) {
        console.error('[PaymentService] Failed to start consumer:', error);
        // Попробовать перезапустить через 5 секунд
        setTimeout(startConsumer, 5000);
    }
}

// Запускаем наш сервис
startConsumer();
console.log("[PaymentService] Service is starting...");