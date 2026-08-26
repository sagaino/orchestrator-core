package cache

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

type DbClient struct {
	client *redis.Client
}

func Default() DbClient {
	password := os.Getenv("REDIS_PASSWORD")
	host := os.Getenv("REDIS_HOST")
	newClient := redis.NewClient(&redis.Options{
		Addr:     host,
		Password: password,
		Protocol: 3,
	})
	pong, err := newClient.Ping(context.Background()).Result()
	if err != nil {
		fmt.Println(err)
	}
	fmt.Println("redis start... ", pong)
	return DbClient{
		client: newClient,
	}
}

// Set stores value in a key with expiration.
func (rdb *DbClient) Set(ctx context.Context, key string, value interface{}, exp time.Duration) error {
	err := rdb.client.Set(ctx, key, value, exp).Err()
	if err != nil {
		return err
	}

	return nil
}

// SetNX stores value if not exists (Not eXists) in a key with expiration.
func (rdb *DbClient) SetNX(ctx context.Context, key string, value interface{}, expiration time.Duration) error {
	err := rdb.client.SetNX(ctx, key, value, expiration).Err()
	if err != nil {
		return err
	}

	return nil
}

// Get retrieves key in form of string.
func (rdb *DbClient) Get(ctx context.Context, key string) (string, error) {
	value, err := rdb.client.Get(ctx, key).Result()
	if err != nil {
		return "", err
	}

	return value, nil
}

// Delete deletes keys.
func (rdb *DbClient) Delete(ctx context.Context, keys ...string) error {
	return rdb.client.Del(ctx, keys...).Err()
}
