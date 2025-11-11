require('dotenv').config();
const express = require('express');
const { createClient } = require('redis');

// --- 1. НАСТРОЙКА И ПОДКЛЮЧЕНИЯ ---

const app = express();
app.use(express.json());

// Создаем и настраиваем клиент Redis
const redisClient = createClient({
  url: process.env.REDIS_URL
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

// --- 2. API ЭНДПОИНТЫ ДЛЯ УПРАВЛЕНИЯ КОРЗИНОЙ ---

// GET /cart/:userId - Получить корзину пользователя
app.get('/cart/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const cartJson = await redisClient.get(`cart:${userId}`);
    if (cartJson) {
      res.status(200).json(JSON.parse(cartJson));
    } else {
      // Если корзины нет, возвращаем пустую структуру
      res.status(200).json({ items: [], totalAmount: 0 });
    }
  } catch (error) {
    console.error('Failed to get cart:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /cart/:userId/items - Добавить товар в корзину
app.post('/cart/:userId/items', async (req, res) => {
    const { userId } = req.params;
    const { productId, quantity, price } = req.body;

    if (!productId || !quantity || !price) {
        return res.status(400).json({ error: 'productId, quantity, and price are required' });
    }

    try {
        let cart = { items: [], totalAmount: 0 };
        const cartJson = await redisClient.get(`cart:${userId}`);
        if (cartJson) {
            cart = JSON.parse(cartJson);
        }

        // Добавляем новый товар и пересчитываем общую сумму
        cart.items.push({ productId, quantity, price });
        cart.totalAmount = cart.items.reduce((sum, item) => sum + item.quantity * item.price, 0);

        // Сохраняем обновленную корзину в Redis
        await redisClient.set(`cart:${userId}`, JSON.stringify(cart));
        res.status(200).json(cart);

    } catch (error) {
        console.error('Failed to add item to cart:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /cart/:userId - Очистить корзину пользователя (например, после создания заказа)
app.delete('/cart/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        await redisClient.del(`cart:${userId}`);
        res.status(204).send(); // 204 No Content - успешное удаление
    } catch (error) {
        console.error('Failed to clear cart:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// --- 3. ЗАПУСК СЕРВЕРА ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    // Подключаемся к Redis при старте сервера
    await redisClient.connect(); 
    console.log(`Cart service listening on port ${PORT}`);
    console.log('Successfully connected to Redis');
});