// Импортируем все необходимые библиотеки
require('dotenv').config(); // Загружает переменные окружения из .env файла
const express = require('express');
const { Pool } = require('pg'); // Драйвер для PostgreSQL
const amqp = require('amqplib'); // Клиент для RabbitMQ
const axios = require('axios'); // Для HTTP-запросов к другим сервисам

// --- 1. НАСТРОЙКА И ПОДКЛЮЧЕНИЯ ---

// Создаем приложение Express
const app = express();
app.use(express.json()); // Включаем парсинг JSON-тела запросов

// Настраиваем подключение к PostgreSQL, используя данные из .env
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Глобальные переменные для RabbitMQ
let rabbitConnection;
let rabbitChannel;

// Функция для подключения к RabbitMQ
async function connectRabbitMQ() {
  try {
    rabbitConnection = await amqp.connect(process.env.RABBITMQ_URL);
    rabbitChannel = await rabbitConnection.createChannel();
    await rabbitChannel.assertExchange('orders_exchange', 'topic', { durable: true });
    console.log('Successfully connected to RabbitMQ');
  } catch (error) {
    console.error('Failed to connect to RabbitMQ', error);
    // Попробовать переподключиться через 5 секунд
    setTimeout(connectRabbitMQ, 5000);
  }
}

// --- 2. ГЛАВНЫЙ ЭНДПОИНТ ДЛЯ СОЗДАНИЯ ЗАКАЗА ---

// POST /orders - эндпоинт для создания нового заказа
app.post('/orders', async (req, res) => {
  // В реальном приложении userId будет приходить из токена аутентификации
  const { userId, shippingAddress } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  // Получаем клиент из пула для выполнения транзакции
  const dbClient = await pgPool.connect();
  
  try {
    // --- Шаг A: Получение корзины от Сервиса Корзины ---
let cart;
try {
    const cartServiceUrl = process.env.CART_SERVICE_URL.replace('cart-service', 'localhost');
    const cartResponse = await axios.get(`${cartServiceUrl}/cart/${userId}`);
    cart = cartResponse.data;
} catch (error) {
    console.error('Failed to get cart from cart-service:', error.message);
    return res.status(500).json({ error: 'Could not retrieve cart' });
}
    
    if (!cart.items || cart.items.length === 0) {
        return res.status(400).json({ error: 'Cart is empty' });
    }

    // --- Шаг B: Начинаем транзакцию в базе данных ---
    await dbClient.query('BEGIN');
    
    // --- Шаг C: Сохраняем основной заказ в таблицу 'orders' ---
    const orderInsertQuery = `
      INSERT INTO orders (user_id, status, total_amount, shipping_address)
      VALUES ($1, 'PendingPayment', $2, $3)
      RETURNING order_id, created_at;
    `;
    const orderResult = await dbClient.query(orderInsertQuery, [userId, cart.totalAmount, shippingAddress]);
    const newOrderId = orderResult.rows[0].order_id;
    const orderCreatedAt = orderResult.rows[0].created_at;

    // --- Шаг D: Сохраняем каждый товар из корзины в 'order_items' ---
    for (const item of cart.items) {
      const itemInsertQuery = `
        INSERT INTO order_items (order_id, product_id, quantity, price)
        VALUES ($1, $2, $3, $4);
      `;
      await dbClient.query(itemInsertQuery, [newOrderId, item.productId, item.quantity, item.price]);
    }
    
    // --- Шаг E: Завершаем транзакцию ---
    await dbClient.query('COMMIT');
    
    // --- Шаг F: Публикуем событие "OrderCreated" в RabbitMQ ---
    const eventMessage = {
      orderId: newOrderId,
      userId: userId,
      totalAmount: cart.totalAmount,
      createdAt: orderCreatedAt,
    };
    rabbitChannel.publish(
        'orders_exchange',      // Название обменника
        'order.created',        // Ключ маршрутизации
        Buffer.from(JSON.stringify(eventMessage)) // Сообщение
    );
    console.log(`Published OrderCreated event for orderId: ${newOrderId}`);

    // --- Шаг G: Отправляем успешный ответ клиенту ---
    res.status(201).json({ message: 'Order created successfully!', orderId: newOrderId });

  } catch (error) {
    // Если произошла любая ошибка, откатываем транзакцию
    await dbClient.query('ROLLBACK');
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    // Освобождаем клиент, чтобы вернуть его в пул
    dbClient.release();
  }
});


// --- ДОБАВЛЕННЫЙ БЛОК: ПОДПИСЧИК НА СОБЫТИЯ ОБ ОПЛАТЕ ---

async function consumePaymentEvents() {
    // Используем тот же канал RabbitMQ, что и для публикации
    if (!rabbitChannel) {
        console.warn("RabbitMQ channel not available, skipping payment consumer setup.");
        return;
    }

    try {
        const exchange = 'orders_exchange';
        const queueName = 'order_service_payment_queue';
        const routingKey = 'payment.successful'; // Слушаем именно этот ключ

        await rabbitChannel.assertExchange(exchange, 'topic', { durable: true });
        const q = await rabbitChannel.assertQueue(queueName, { durable: true });
        
        await rabbitChannel.bindQueue(q.queue, exchange, routingKey);

        console.log(`[OrderService] Waiting for successful payment events in queue: ${q.queue}`);

        rabbitChannel.consume(q.queue, async (msg) => {
            if (msg.content) {
                const eventData = JSON.parse(msg.content.toString());
                const { orderId } = eventData;
                
                console.log(`[OrderService] Received PaymentSuccessful event for orderId: ${orderId}`);
                
                // Обновляем статус заказа в нашей базе данных
                try {
                    await pgPool.query("UPDATE orders SET status = 'Paid', updated_at = NOW() WHERE order_id = $1", [orderId]);
                    console.log(`[OrderService] Order ${orderId} status updated to 'Paid'.`);
                    rabbitChannel.ack(msg);
                } catch (dbError) {
                    console.error(`[OrderService] DB error updating order ${orderId}:`, dbError);
                    // Вернуть сообщение в очередь для повторной попытки
                    rabbitChannel.nack(msg, false, true); 
                }
            }
        }, { noAck: false });

    } catch (error) {
        console.error("[OrderService] Failed to start payment event consumer", error);
    }
}
// --- 3. ЗАПУСК СЕРВЕРА ---

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Order service listening on port ${PORT}`);
  // Подключаемся к RabbitMQ после запуска сервера
 connectRabbitMQ().then(() => {
      // Запускаем подписчика только после успешного подключения к RabbitMQ
      consumePaymentEvents(); 
    });
});