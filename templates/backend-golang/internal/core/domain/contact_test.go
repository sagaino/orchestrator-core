package domain

import (
	"testing"
)

func TestContact_TableName(t *testing.T) {
	c := Contact{}
	if got := c.TableName(); got != "contacts" {
		t.Errorf("Contact.TableName() = %v, want %v", got, "contacts")
	}
}

func TestContact_BaseEntity(t *testing.T) {
	uuidStr := "550e8400-e29b-41d4-a716-446655440000"
	c := Contact{
		BaseEntity: BaseEntity{
			ID: uuidStr,
		},
		Name:        "John Doe",
		PhoneNumber: "081234567890",
	}
	c.SetCreated("test-user")

	if c.ID != uuidStr {
		t.Errorf("expected ID %v, got %v", uuidStr, c.ID)
	}
	if c.Name != "John Doe" {
		t.Errorf("expected Name 'John Doe', got %v", c.Name)
	}
	if c.PhoneNumber != "081234567890" {
		t.Errorf("expected PhoneNumber '081234567890', got %v", c.PhoneNumber)
	}
	if c.CreatedBy != "test-user" {
		t.Errorf("expected CreatedBy 'test-user', got %v", c.CreatedBy)
	}
	if c.CreatedAt.IsZero() {
		t.Errorf("expected CreatedAt not to be zero")
	}
}
